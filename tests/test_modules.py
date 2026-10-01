"""内置模块组合的行为契约；所有写入只使用临时目录。"""
import base64
import copy
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

    def modules(self, acquisition=False, trading=False, circulation=False):
        return self.store.set_modules(dict(acquisition=acquisition, trading=trading, circulation=circulation))

    def test_new_and_legacy_instances(self):
        self.assertTrue(self.store.state()['modules']['needsSetup'])
        self.assertNotIn('modules-v1', self.store.backup()['settings'])
        self.store.save({'title': '专辑', 'artist': '艺人'})
        config = self.store.state()['modules']
        self.assertFalse(config['needsSetup'])
        self.assertFalse(config['configured'])
        self.assertTrue(all(config['enabled'].values()))

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
                        {'acquisition': True, 'trading': False, 'circulation': False, 'unknown': True}):
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
        self.modules(acquisition=True)
        self.store.save({'title': '来源', 'artist': '艺人', 'currency': 'CNY', 'price': '15'})
        backup = self.store.backup()
        self.modules(trading=True)
        self.store.restore_backup(copy.deepcopy(backup))
        self.assertEqual(self.store.state()['modules']['enabled'], backup['settings']['modules-v1'])
        bad = copy.deepcopy(backup)
        bad['settings']['modules-v1']['circulation'] = True
        bad['settings']['modules-v1']['acquisition'] = False
        with self.assertRaises(ValidationError): self.store.restore_backup(bad)
        self.assertEqual(self.store.backup()['records'], backup['records'])

