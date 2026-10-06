"""展示组的有序实物清单、跨设备竞争与备份契约；只使用临时库。"""
import copy
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

from domain import ConflictError, ValidationError, clean_showcase_groups
from server import routes
from storage import SCHEMA, Store


KEY = 'showcase-groups-v1'


class ShowcaseGroupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'albums.sqlite3')
        self.modules(True)
        self.ids = self.store.save({'items': [
            {'title': '同名专辑', 'artist': '艺人 A', 'version': '纸套'},
            {'title': '同名专辑', 'artist': '艺人 A', 'version': '碟盒'},
            {'title': '另一张', 'artist': '艺人 B'},
        ]})['ids']

    def tearDown(self):
        self.tmp.cleanup()

    def modules(self, enabled):
        self.store.set_modules({'acquisition': False, 'trading': True,
                                'circulation': False, 'showcase': enabled})

    def create(self, name='我的组', ids=None, revision=0):
        return self.store.change_showcase_groups({'action': 'create', 'expectedRevision': revision,
                                                  'name': name, 'recordIds': self.ids if ids is None else ids})

    def group_state(self):
        return self.store.state()['settings'].get(KEY, {'revision': 0, 'groups': []})

    def unchanged(self, before):
        after = self.store.backup()
        for key in ('records', 'sales', 'shipments', 'settings', 'audit'):
            self.assertEqual(after[key], before[key], key)

    def test_crud_preserves_order_independent_copies_overlap_and_record_data(self):
        original = self.store.backup()['records']
        self.assertNotIn(KEY, self.store.state()['settings'])
        ordered = [self.ids[2], self.ids[0], self.ids[1]]
        first = self.create('  第一组  ', ordered)
        group = first['groups'][0]
        self.assertRegex(group['id'], r'^[0-9a-f]{32}$')
        self.assertEqual((group['name'], group['recordIds'], first['revision']), ('第一组', ordered, 1))
        second = self.create('第二组', [self.ids[1], self.ids[0]], 1)
        self.assertEqual(second['groups'][0], group)
        changed = self.store.change_showcase_groups({
            'action': 'update', 'expectedRevision': 2, 'id': group['id'],
            'name': '重新命名', 'recordIds': [self.ids[1], self.ids[2]],
        })
        self.assertEqual(changed['groups'][0], {'id': group['id'], 'name': '重新命名',
                                               'recordIds': [self.ids[1], self.ids[2]]})
        remaining = self.store.change_showcase_groups({'action': 'delete', 'expectedRevision': 3,
                                                        'id': group['id']})
        self.assertEqual(remaining['revision'], 4)
        self.assertEqual(remaining['groups'], [second['groups'][1]])
        self.assertEqual(self.store.backup()['records'], original)
        self.assertEqual(self.group_state(), {'revision': 4, 'groups': remaining['groups']})

    def test_sold_and_trash_memberships_are_retained(self):
        group = self.create()['groups'][0]
        self.store.bulk({'action': 'delete', 'ids': [self.ids[0]]})
        sale = self.store.sell({'ids': [self.ids[1]], 'gross': '12.50', 'date': '2026-01-01'})
        self.store.sale_action({'id': sale['id'], 'action': 'receive', 'date': '2026-01-02'})
        self.assertEqual(self.group_state()['groups'][0], group)
        states = {r['id']: r['status'] for r in self.store.state()['records']}
        self.assertEqual((states[self.ids[0]], states[self.ids[1]]), ('trash', 'sold'))
        self.store.bulk({'action': 'restore', 'ids': [self.ids[0]]})
        self.assertEqual(self.group_state()['groups'][0], group)

    def test_empty_group_is_supported(self):
        result = self.create(ids=[])
        self.assertEqual(result['groups'][0]['recordIds'], [])

    def test_disabled_module_rejects_mutations_and_preserves_saved_groups(self):
        group = self.create()['groups'][0]
        self.modules(False)
        before = self.store.backup()
        requests = [
            {'action': 'create', 'expectedRevision': 1, 'name': '新组', 'recordIds': []},
            {'action': 'update', 'expectedRevision': 1, 'id': group['id'], 'name': '改名', 'recordIds': []},
            {'action': 'delete', 'expectedRevision': 1, 'id': group['id']},
        ]
        for request in requests:
            with self.subTest(request=request), self.assertRaisesRegex(ValidationError, '收藏展示'):
                self.store.change_showcase_groups(request)
            self.unchanged(before)
        self.modules(True)
        self.assertEqual(self.group_state()['groups'], [group])

    def test_stale_write_is_rejected_without_partial_change(self):
        result = self.create()
        before = self.store.backup()
        for action in ('create', 'update', 'delete'):
            request = {'action': action, 'expectedRevision': 0}
            if action != 'create': request['id'] = result['groups'][0]['id']
            if action != 'delete': request.update(name='旧设备', recordIds=self.ids[::-1])
            with self.subTest(action=action), self.assertRaises(ConflictError):
                self.store.change_showcase_groups(request)
            self.unchanged(before)

    def test_simultaneous_store_writers_cannot_both_accept_old_revision(self):
        barrier = threading.Barrier(2)

        def write(name):
            barrier.wait(timeout=5)
            try:
                self.create(name)
                return 'ok'
            except ConflictError:
                return 'conflict'

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, ['甲设备', '乙设备']))
        self.assertCountEqual(results, ['ok', 'conflict'])
        self.assertEqual(self.group_state()['revision'], 1)
        self.assertEqual(len(self.group_state()['groups']), 1)

    def test_invalid_requests_leave_meta_and_records_unchanged(self):
        before = self.store.backup()
        valid = {'action': 'create', 'expectedRevision': 0, 'name': '组', 'recordIds': self.ids}
        requests = [None, [], {}, {**valid, 'action': 'unknown'}, {**valid, 'id': 'a' * 32},
                    {**valid, 'name': None}, {**valid, 'name': '   '}, {**valid, 'name': 'a' * 101},
                    {**valid, 'recordIds': 'invalid'}, {**valid, 'recordIds': [True]},
                    {**valid, 'recordIds': ['a' * 31]}, {**valid, 'recordIds': [self.ids[0]] * 2},
                    {**valid, 'recordIds': ['f' * 32]}, {**valid, 'expectedRevision': True},
                    {**valid, 'expectedRevision': -1}, {**valid, 'expectedRevision': '0'},
                    {'action': 'delete', 'expectedRevision': 0, 'id': 'g' * 32},
                    {'action': 'delete', 'expectedRevision': 0, 'id': 'f' * 32}]
        for request in requests:
            with self.subTest(request=request), self.assertRaises(ValidationError):
                self.store.change_showcase_groups(request)
            self.unchanged(before)

    def test_backup_round_trip_preserves_group_order_and_module_off_data(self):
        first = self.create(ids=self.ids[::-1])
        self.modules(False)
        snapshot = self.store.backup()
        self.assertEqual(snapshot['schema'], SCHEMA)
        with tempfile.TemporaryDirectory() as folder:
            restored = Store(Path(folder) / 'albums.sqlite3')
            restored.restore_backup(copy.deepcopy(snapshot))
            state = restored.state()
            self.assertEqual(state['settings'][KEY], {'revision': 1, 'groups': first['groups']})
            self.assertFalse(state['modules']['enabled']['showcase'])
            self.assertEqual(restored.backup()['records'], snapshot['records'])

    def test_restore_accepts_absent_record_ids_without_reviving_records(self):
        group = self.create()['groups'][0]
        snapshot = self.store.backup()
        snapshot['records'] = [r for r in snapshot['records'] if r['id'] != self.ids[0]]
        self.store.restore_backup(copy.deepcopy(snapshot))
        self.assertEqual(self.group_state()['groups'], [group])
        self.assertNotIn(self.ids[0], {r['id'] for r in self.store.state()['records']})
        updated = self.store.change_showcase_groups({'action': 'update', 'expectedRevision': 1,
                                                     'id': group['id'], 'name': '保留历史',
                                                     'recordIds': group['recordIds'][::-1]})
        self.assertEqual(updated['groups'][0]['recordIds'], group['recordIds'][::-1])

    def test_old_backup_without_groups_remains_restorable(self):
        snapshot = self.store.backup()
        self.create()
        self.store.restore_backup(copy.deepcopy(snapshot))
        self.assertNotIn(KEY, self.store.state()['settings'])
        self.assertEqual(self.create(ids=[])['revision'], 1)

    def test_invalid_backup_groups_fail_before_checkpoint_or_any_write(self):
        saved = self.create()
        before = self.store.backup()
        group = saved['groups'][0]
        invalid = [None, [], {}, {'revision': True, 'groups': []}, {'revision': -1, 'groups': []},
                   {'revision': 1, 'groups': {}}, {'revision': 1, 'groups': [group, group]},
                   {'revision': 1, 'groups': [{**group, 'recordIds': [self.ids[0]] * 2}]},
                   {'revision': 1, 'groups': [{**group, 'name': ' '}]},
                   {'revision': 1, 'groups': [{**group, 'id': 'invalid'}]}]
        for value in invalid:
            snapshot = copy.deepcopy(before)
            snapshot['settings'][KEY] = value
            snapshot['records'][0]['title'] = '不应写入'
            with self.subTest(value=value), self.assertRaises(ValidationError):
                self.store.restore_backup(snapshot)
            self.unchanged(before)
            self.assertFalse((Path(self.tmp.name) / 'backups').exists())

    def test_route_requires_login_and_write_lock_and_returns_latest_meta(self):
        handler, requires_login, write_lock = routes.resolve_post('/api/showcase/groups')
        self.assertTrue(requires_login)
        self.assertTrue(write_lock)
        responses = []
        handler(SimpleNamespace(send=responses.append), SimpleNamespace(store=self.store),
                {'action': 'create', 'expectedRevision': 0, 'name': '手机组', 'recordIds': self.ids})
        self.assertEqual(responses[0], {'ok': True, **self.group_state()})

    def test_cleaner_preserves_input(self):
        value = {'revision': 0, 'groups': [{'id': 'a' * 32, 'name': ' 组 ', 'recordIds': self.ids[::-1]}]}
        before = copy.deepcopy(value)
        cleaned = clean_showcase_groups(value)
        self.assertEqual(value, before)
        self.assertEqual(cleaned['groups'][0]['name'], '组')
        self.assertEqual(cleaned['groups'][0]['recordIds'], self.ids[::-1])


if __name__ == '__main__':
    unittest.main()
