"""内置模块组合的行为契约；所有写入只使用临时目录。"""
import base64
import copy
import json
import tempfile
import unittest
from pathlib import Path

from domain import ValidationError
from storage import Store


class ModuleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.tmp.name) / 'albums.sqlite3')

    def tearDown(self):
        self.tmp.cleanup()

    def modules(self, acquisition=False, trading=False, circulation=False, showcase=False, start_page=None):
        return self.store.set_modules(dict(acquisition=acquisition, trading=trading, circulation=circulation,
                                           showcase=showcase), start_page)

    def test_new_and_legacy_instances(self):
        self.assertTrue(self.store.state()['modules']['needsSetup'])
        self.assertNotIn('modules-v1', self.store.backup()['settings'])
        self.store.save({'title': '专辑', 'artist': '艺人'})
        config = self.store.state()['modules']
        self.assertFalse(config['needsSetup'])
        self.assertFalse(config['configured'])
        self.assertEqual(config['enabled'], {'acquisition': True, 'trading': True, 'circulation': True,
                                             'showcase': False})
        self.assertEqual(config['startPage'], 'domestic')
        self.assertNotIn('start-page-v1', self.store.backup()['settings'])
        with self.assertRaisesRegex(ValidationError, '收藏展示'):
            self.store.require_module('showcase')

    def test_legacy_configuration_read_normalizes_without_writing(self):
        self.store.save({'title': '旧收藏', 'artist': '艺人'})
        legacy = {'acquisition': True, 'trading': False, 'circulation': False}
        # 模拟旧版本已落盘的三键配置；只在本测试的临时库设置夹具。
        with self.store.connect() as db:
            db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', ('modules-v1', json.dumps(legacy)))
        before = self.store.backup()
        config = self.store.state()['modules']
        self.assertEqual(config['enabled'], {**legacy, 'showcase': False})
        self.assertTrue(config['configured'])
        self.assertFalse(config['needsSetup'])
        self.store.require_module('acquisition')
        with self.assertRaises(ValidationError): self.store.require_module('showcase')
        after = self.store.backup()
        for key in ('records', 'sales', 'shipments', 'settings', 'audit'):
            self.assertEqual(after[key], before[key])

    def test_legacy_client_configuration_is_accepted_with_showcase_off(self):
        legacy = {'acquisition': False, 'trading': True, 'circulation': False}
        result = self.store.set_modules(legacy)
        self.assertEqual(result['enabled'], {**legacy, 'showcase': False})
        self.assertEqual(self.store.backup()['settings']['modules-v1'], result['enabled'])
        self.assertEqual(legacy, {'acquisition': False, 'trading': True, 'circulation': False})

    def test_showcase_is_independent_and_switching_preserves_the_collection(self):
        self.modules()
        photo = 'data:image/jpeg;base64,' + base64.b64encode(b'showcase-photo').decode()
        rid = self.store.save({'title': '欣赏', 'artist': '艺人', 'storage': '书架', 'photos': [photo]})['ids'][0]
        before = self.store.backup()
        self.modules(showcase=True)
        self.store.require_module('showcase')
        with self.assertRaises(ValidationError): self.store.require_module('acquisition')
        self.modules()
        with self.assertRaises(ValidationError): self.store.require_module('showcase')
        after = self.store.backup()
        for key in ('records', 'sales', 'shipments'):
            self.assertEqual(after[key], before[key])
        self.assertEqual((self.store.photos_dir / rid / '0.jpg').read_bytes(), b'showcase-photo')
        self.assertIsNone(self.store.state()['records'][0]['cost'])

    def test_home_page_is_saved_preserved_and_validated_atomically(self):
        result = self.modules(showcase=True, start_page='gallery')
        self.assertEqual(result['startPage'], 'gallery')
        self.assertEqual(self.store.state()['modules']['startPage'], 'gallery')
        self.modules()  # 关闭欣赏，省略首页仍保留原偏好。
        self.assertEqual(self.store.state()['modules']['startPage'], 'gallery')
        self.modules(showcase=True)
        before = self.store.backup()
        for start_page in ('settings', '', 1, False, [], {}):
            with self.subTest(start_page=start_page), self.assertRaises(ValidationError):
                self.modules(acquisition=True, start_page=start_page)
            after = self.store.backup()
            self.assertEqual(after['settings'], before['settings'])
            self.assertEqual(after['audit'], before['audit'])
        self.modules(showcase=True, start_page='domestic')
        self.assertEqual(self.store.state()['modules']['startPage'], 'domestic')

    def test_collection_without_purchase_information(self):
        self.modules()
        self.store.save({'title': '收藏', 'artist': '艺人', 'storage': '书房第二层'})
        r = self.store.state()['records'][0]
        self.assertEqual((r['status'], r['currency'], r['date'], r['price']), ('domestic', 'CNY', '', ''))
        self.assertIsNone(r['cost'])
        self.assertEqual(r['storage'], '书房第二层')
        self.assertFalse(self.store.state()['modules']['needsSetup'])

    def test_currency_does_not_choose_location_without_circulation(self):
        self.modules(acquisition=True)
        self.store.save({'title': '日元买入', 'artist': '艺人', 'currency': 'JPY', 'price': '100'})
        self.assertEqual(self.store.state()['records'][0]['status'], 'domestic')
        with self.assertRaises(ValidationError):
            self.store.save({'title': '旧客户端', 'artist': '艺人', 'status': 'overseas'})
        preview = self.store.import_preview([{'id': 'source-1', 'title': '导入', 'artist': '艺人', 'purchase': {'currency': 'JPY', 'priceValue': '200'}}])
        self.assertEqual(preview['records'][0]['status'], 'domestic')

    def test_strict_configuration_and_dependency(self):
        for enabled in (None, {}, {'acquisition': 1, 'trading': False, 'circulation': False},
                        {'acquisition': False, 'trading': False, 'circulation': True},
                        {'acquisition': True, 'trading': False, 'circulation': False, 'unknown': True},
                        {'acquisition': False, 'circulation': False, 'showcase': True},
                        {'acquisition': False, 'trading': False, 'circulation': False, 'showcase': 1},
                        {'acquisition': False, 'trading': False, 'circulation': False, 'showcase': 'true'},
                        {'acquisition': False, 'trading': False, 'circulation': False, 'showcase': None}):
            with self.subTest(enabled=enabled), self.assertRaises(ValidationError):
                self.store.set_modules(enabled)
        self.assertNotIn('modules-v1', self.store.backup()['settings'])
        self.modules(acquisition=True, circulation=True)
        self.assertFalse(self.store.state()['modules']['enabled']['trading'])

    def test_switch_preserves_records_packages_sales_and_photos(self):
        photo = 'data:image/jpeg;base64,' + base64.b64encode(b'fixture-image').decode()
        overseas = self.store.save({'title': '在途', 'artist': '艺人', 'currency': 'JPY', 'photos': [photo]})['ids'][0]
        shipment = self.store.ship({'ids': [overseas], 'method': '航空', 'cost': '1', 'date': '2026-10-01'})['id']
        home = self.store.save({'title': '交易', 'artist': '艺人', 'currency': 'CNY', 'price': '12.34', 'actual': '', 'date': '2026-09-01'})['ids'][0]
        sale = self.store.sell({'ids': [home], 'gross': '20', 'fees': '1', 'date': '2026-10-01'})['id']
        before = self.store.backup()
        self.modules()
        after = self.store.backup()
        for key in ('records', 'shipments', 'sales'):
            self.assertEqual(before[key], after[key])
        self.assertEqual((self.store.photos_dir / overseas / '0.jpg').read_bytes(), b'fixture-image')
        for op in (lambda: self.store.shipment_action({'id': shipment, 'action': 'arrive', 'date': '2026-10-01'}),
                   lambda: self.store.update_shipment({'id': shipment, 'note': 'changed'}),
                   lambda: self.store.sale_action({'id': sale, 'action': 'receive', 'date': '2026-10-01'})):
            with self.assertRaises(ValidationError): op()
        self.modules(acquisition=True, trading=True, circulation=True)
        self.store.shipment_action({'id': shipment, 'action': 'arrive', 'date': '2026-10-01'})
        self.store.sale_action({'id': sale, 'action': 'receive', 'date': '2026-10-01'})
        self.assertEqual(self.store.state()['sales'][0]['items'][0]['profit'], '6.66')

    def test_disabled_actions_and_independent_trading(self):
        self.modules()
        rid = self.store.save({'title': '收藏', 'artist': '艺人'})['ids'][0]
        for op in (lambda: self.store.bulk({'ids': [rid], 'action': 'list'}),
                   lambda: self.store.bulk({'ids': [rid], 'action': 'to_overseas'}),
                   lambda: self.store.sell({'ids': [rid], 'gross': '10', 'fees': '0', 'date': '2026-10-01'}),
                   lambda: self.store.ship({'ids': [rid]})):
            with self.assertRaises(ValidationError): op()
        self.modules(trading=True)
        self.store.bulk({'ids': [rid], 'action': 'list'})
        sid = self.store.sell({'ids': [rid], 'gross': '10', 'fees': '0', 'date': '2026-10-01'})['id']
        self.store.sale_action({'id': sid, 'action': 'receive', 'date': '2026-10-01'})
        item = self.store.state()['sales'][0]['items'][0]
        self.assertEqual(item['net'], '10.00')
        self.assertIsNone(item['profit'])

    def test_backup_restores_configuration_and_rejects_bad_configuration(self):
        self.modules(acquisition=True, showcase=True, start_page='gallery')
        self.store.save({'title': '来源', 'artist': '艺人', 'currency': 'CNY', 'price': '15'})
        backup = self.store.backup()
        self.modules(trading=True)
        self.store.restore_backup(copy.deepcopy(backup))
        self.assertEqual(self.store.state()['modules']['enabled'], backup['settings']['modules-v1'])
        self.assertEqual(self.store.state()['modules']['startPage'], 'gallery')
        bad = copy.deepcopy(backup)
        bad['settings']['modules-v1']['circulation'] = True
        bad['settings']['modules-v1']['acquisition'] = False
        with self.assertRaises(ValidationError): self.store.restore_backup(bad)
        self.assertEqual(self.store.backup()['records'], backup['records'])
        before = self.store.backup()
        for start_page in ('settings', None, 1):
            bad = copy.deepcopy(backup)
            bad['settings']['start-page-v1'] = start_page
            with self.subTest(start_page=start_page), self.assertRaises(ValidationError):
                self.store.restore_backup(bad)
            after = self.store.backup()
            for key in ('records', 'sales', 'shipments', 'settings', 'audit'):
                self.assertEqual(after[key], before[key])

    def test_legacy_backup_normalizes_new_module_without_changing_records(self):
        self.modules(acquisition=True)
        self.store.save({'title': '旧备份', 'artist': '艺人', 'currency': 'CNY', 'price': '15'})
        legacy = self.store.backup()
        legacy['settings']['modules-v1'].pop('showcase')
        self.modules(trading=True, showcase=True, start_page='gallery')
        self.store.restore_backup(copy.deepcopy(legacy))
        restored = self.store.backup()
        for key in ('records', 'sales', 'shipments'):
            self.assertEqual(restored[key], legacy[key])
        self.assertEqual(restored['settings']['modules-v1'],
                         {**legacy['settings']['modules-v1'], 'showcase': False})
        self.assertEqual(self.store.state()['modules']['startPage'], 'domestic')
        self.assertNotIn('start-page-v1', restored['settings'])
        self.assertNotIn('showcase', legacy['settings']['modules-v1'])

    def test_backup_without_configuration_keeps_legacy_business_defaults(self):
        self.store.save({'title': '未配置的收藏', 'artist': '艺人'})
        legacy = self.store.backup()
        self.modules(showcase=True, start_page='gallery')
        self.store.restore_backup(copy.deepcopy(legacy))
        config = self.store.state()['modules']
        self.assertEqual(config['enabled'], {'acquisition': True, 'trading': True, 'circulation': True,
                                             'showcase': False})
        self.assertFalse(config['configured'])
        self.assertEqual(config['startPage'], 'domestic')
        self.assertEqual(self.store.backup()['records'], legacy['records'])

    def test_listing_roundtrip_validation_and_core_edit_preservation(self):
        self.modules(trading=True)
        rid = self.store.save({'title': '出售', 'artist': '艺人'})['ids'][0]
        self.store.bulk({'action': 'list', 'ids': [rid], 'listing': {'channel': '二手平台', 'url': 'https://example.test/item/1'}})
        r = self.store.state()['records'][0]
        self.store.save({'id': rid, 'revision': r['revision'], 'storage': '柜子', 'listingUrl': 'https://other.test'})
        self.assertEqual(self.store.state()['records'][0]['listingUrl'], 'https://example.test/item/1')
        for url in ('javascript:alert(1)', 'https://user:pass@example.test', 'https://[broken'):
            with self.subTest(url=url), self.assertRaises(ValidationError):
                self.store.bulk({'action': 'list', 'ids': [rid], 'listing': {'url': url}})
        self.store.bulk({'action': 'unlist', 'ids': [rid]})
        self.assertFalse(self.store.state()['records'][0].get('listed', False))
        self.assertEqual(self.store.state()['records'][0]['listingChannel'], '二手平台')
        backup = self.store.backup()
        self.store.restore_backup(copy.deepcopy(backup))
        self.assertEqual(self.store.state()['records'][0]['listingUrl'], 'https://example.test/item/1')


if __name__ == '__main__':
    unittest.main()
