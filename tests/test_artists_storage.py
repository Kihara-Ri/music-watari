"""艺人身份绑定与副本-作品关联：事务、竞争校验、审计与备份恢复。"""
import tempfile, unittest
from pathlib import Path

from domain import ValidationError, ConflictError
from storage import Store, clean_artist_identities, clean_work_links

MBID_A = '11111111-1111-1111-1111-111111111111'
MBID_B = '22222222-2222-2222-2222-222222222222'
RG_1 = '33333333-3333-3333-3333-333333333333'
RG_2 = '44444444-4444-4444-4444-444444444444'


class ArtistStorageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'db.sqlite3')
        self.rid = self.store.save({'title': '测试专辑', 'artist': '艺人'})['ids'][0]

    def tearDown(self): self.tmp.cleanup()

    def bind(self, **kw):
        return self.store.bind_artist_identity(kw.get('artist', '艺人'), kw.get('mbid', MBID_A),
                                               kw.get('source', '艺人'), 'manual', kw.get('expected'))

    def test_bind_roundtrip_and_audit(self):
        saved = self.bind()
        self.assertEqual(saved['artistMbid'], MBID_A)
        self.assertEqual(saved['method'], 'manual')
        self.assertEqual(self.store.artist_identities(), {'艺人': saved})
        with self.store.connect() as db:
            actions = [r['action'] for r in db.execute('SELECT action FROM audit')]
        self.assertIn('确认艺人', actions)
        # 备份携带绑定，恢复后仍在
        backup = self.store.backup()
        self.assertIn('artist-identities-v1', backup['settings'])
        other = Store(Path(self.tmp.name) / 'other.sqlite3')
        other.restore_backup(backup)
        self.assertEqual(other.artist_identities(), {'艺人': saved})

    def test_single_default_identity_backup_restore(self):
        saved = self.store.bind_artist_identity('艺人', MBID_A, '艺人', 'single', None)
        other = Store(Path(self.tmp.name) / 'single-restore.sqlite3')
        other.restore_backup(self.store.backup())
        self.assertEqual(other.artist_identities()['艺人'], saved)
        self.assertEqual(saved['method'], 'single')

    def test_bind_expected_conflict(self):
        self.bind()
        # 迟到的自动解析带着「未绑定」预期 → 拒绝，不覆盖人工绑定
        with self.assertRaises(ConflictError):
            self.store.bind_artist_identity('艺人', MBID_B, '艺人', 'corroborated', None)
        with self.assertRaises(ConflictError):
            self.bind(expected=MBID_B)  # 预期是旧编号
        self.assertEqual(self.store.artist_identities()['艺人']['artistMbid'], MBID_A)
        # 带正确预期的更换才生效，并记录「更换艺人」审计
        self.bind(mbid=MBID_B, expected=MBID_A)
        self.assertEqual(self.store.artist_identities()['艺人']['artistMbid'], MBID_B)
        with self.store.connect() as db:
            actions = [r['action'] for r in db.execute('SELECT action FROM audit')]
        self.assertIn('更换艺人', actions)

    def test_bind_input_validation(self):
        for args in (('', MBID_A, 'n', 'manual', None), ('艺' * 501, MBID_A, 'n', 'manual', None),
                     ('艺人', 'nope', 'n', 'manual', None), ('艺人', MBID_A, '', 'manual', None),
                     ('艺人', MBID_A, 'n', 'auto', None), ('艺人', MBID_A, 'n', 'manual', 'bad')):
            with self.assertRaises(ValidationError):
                self.store.bind_artist_identity(*args)
        self.assertEqual(self.store.artist_identities(), {})

    def test_link_roundtrip_snapshot_and_audit(self):
        self.bind()
        link = self.store.link_record_work(self.rid, MBID_A, RG_1, None, '艺人', '测试专辑')
        self.assertEqual(link['releaseGroupMbid'], RG_1)
        self.assertEqual(self.store.record_work_links()[self.rid]['recordTitle'], '测试专辑')
        # 预期不符（迟到请求）→ 拒绝
        with self.assertRaises(ConflictError):
            self.store.link_record_work(self.rid, MBID_A, RG_2, None, '艺人', '测试专辑')
        old_revision = next(r for r in self.store.state()['records'] if r['id'] == self.rid)['revision']
        self.store.save({'id': self.rid, 'revision': old_revision, 'title': '改名专辑'})
        with self.assertRaises(ConflictError):
            self.store.link_record_work(self.rid, MBID_A, RG_2, RG_1, '艺人', '测试专辑')
        # 正确预期的重新关联生效；取消关联也要对上预期
        link = self.store.link_record_work(self.rid, MBID_A, RG_2, RG_1, '艺人', '改名专辑')
        self.assertEqual(link['releaseGroupMbid'], RG_2)
        self.store.unlink_record_work(self.rid, RG_2)
        self.assertEqual(self.store.record_work_links(), {})
        with self.assertRaises(ConflictError):
            self.store.unlink_record_work(self.rid, RG_2)
        with self.store.connect() as db:
            actions = [r['action'] for r in db.execute('SELECT action FROM audit')]
        self.assertIn('关联作品', actions); self.assertIn('取消作品关联', actions)

    def test_link_requires_existing_record(self):
        self.bind()
        with self.assertRaises(ValidationError):
            self.store.link_record_work('f' * 32, MBID_A, RG_1, None, '艺人', '测试专辑')

    def test_backup_restore_validates_new_keys(self):
        self.bind()
        self.store.link_record_work(self.rid, MBID_A, RG_1, None, '艺人', '测试专辑')
        backup = self.store.backup()
        other = Store(Path(self.tmp.name) / 'other.sqlite3')
        other.restore_backup(backup)
        self.assertEqual(other.record_work_links()[self.rid]['releaseGroupMbid'], RG_1)
        # 结构损坏的恢复必须整体拒绝
        for mutate in (lambda s: s['artist-identities-v1'].update({'x': {'artistMbid': MBID_A}}),
                       lambda s: s['artist-identities-v1'].update({'艺人': {'artistMbid': 'bad'}}),
                       lambda s: s['record-work-links-v1'].update({self.rid: {'releaseGroupMbid': 'bad'}}),
                       lambda s: s['record-work-links-v1'].update({self.rid: None})):
            broken = {**backup, 'settings': {**backup['settings']}}
            mutate(broken['settings'])
            with self.assertRaises(ValidationError):
                other.restore_backup(broken)

    def test_old_backup_without_new_keys_restores(self):
        legacy = {'format': 'album-ledger', 'schema': 4, 'createdAt': '2026-01-01T00:00:00',
                  'records': [{'id': 'a1', 'title': 'T', 'artist': 'A', 'date': '', 'price': '',
                               'currency': 'CNY', 'fees': '0.00', 'actual': '', 'cover': '',
                               'status': 'domestic', 'revision': 1, 'createdAt': '2026-01-01T00:00:00'}],
                  'sales': [], 'audit': [], 'settings': {'rym-links': {'A': 'https://rateyourmusic.com/artist/a'},
                                                          'rym-token': 'tok'}}
        self.store.restore_backup(legacy)
        self.assertEqual(self.store.artist_identities(), {})
        self.assertEqual(self.store.record_work_links(), {})
        # 历史 RYM 数据原样保留：不删除、不改写
        b = self.store.backup()
        self.assertEqual(b['settings']['rym-links'], legacy['settings']['rym-links'])
        self.assertEqual(b['settings']['rym-token'], 'tok')

    def test_clean_helpers_strip_unknown_fields(self):
        ident = clean_artist_identities({'艺人': {'artistMbid': MBID_A, 'sourceName': 'n', 'method': 'manual',
                                                 'confirmedAt': '2026-10-02T00:00:00', 'junk': 1}})
        self.assertEqual(set(ident['艺人']), {'artistMbid', 'sourceName', 'method', 'confirmedAt'})
        with self.assertRaises(ValidationError): clean_artist_identities([])
        with self.assertRaises(ValidationError): clean_work_links({'x' * 33: {}})


if __name__ == '__main__':
    unittest.main()
