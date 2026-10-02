import json, tempfile, unittest, base64
from pathlib import Path
from decimal import Decimal
from datetime import date, timedelta
from unittest.mock import patch
from domain import clean_record, cost, allocate, ValidationError
from storage import Store, SCHEMA
from rates import RateService

class FakeRates:
    """Deterministic per-100 rate for tests; unknown dates → None."""
    def __init__(self, table): self.table=dict(table)
    def get(self, day): return self.table.get(str(day)[:10])
    def warm(self, days): pass
    def status(self): return {'days': len(self.table), 'latest': max(self.table) if self.table else None}

class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.store=Store(Path(self.tmp.name)/'db.sqlite3', FakeRates({'2026-09-07':'4.8','2026-01-22':'4.4'}))
    def tearDown(self):self.tmp.cleanup()
    def buy(self, **kw):
        d={'title':'测试专辑','artist':'艺人','date':'2026-09-07','price':'2000','currency':'JPY','fees':'10',**kw}
        return self.store.save(d)['ids'][0]
    def record(self,id):return next(r for r in self.store.state()['records'] if r['id']==id)
    def sell(self,ids,**kw):return self.store.sell({'ids':ids,'gross':'160','fees':'10','date':'2026-09-07',**kw})['id']
    def sale(self,id):return next(s for s in self.store.state()['sales'] if s['id']==id)
    def ship(self,ids,**kw):return self.store.ship({'ids':ids,'method':'EMS','cost':'30','date':'2026-09-07',**kw})['id']
    # ── cost model ──
    def test_auto_rate_cost(self):
        id=self.buy();self.assertEqual(self.record(id)['cost'],'106.00')
    def test_edition_roundtrip(self):
        id=self.buy(version='纸盒',pressing='日版',obi='无侧标');r=self.record(id)
        self.assertEqual(r['version'],'纸盒');self.assertEqual(r['pressing'],'日版');self.assertEqual(r['obi'],'无侧标')
        self.assertEqual(self.record(self.buy())['version'],'')
        self.assertEqual(self.record(self.buy())['pressing'],'')
    def test_photos_roundtrip(self):
        jpeg='data:image/jpeg;base64,'+base64.b64encode(b'\xff\xd8fakejpegbytes').decode()
        pid=self.buy(photos=[jpeg,jpeg])
        r=self.record(pid);self.assertEqual(r['photoCount'],2)
        d=self.store.photos_dir/pid;self.assertEqual(len(list(d.iterdir())),2)
        self.store.save({'id':pid,'revision':self.record(pid)['revision'],'photos':[0,jpeg]})
        self.assertEqual(self.record(pid)['photoCount'],2)
        self.assertEqual(sorted(p.name for p in d.iterdir()),['0.jpg','1.jpg'])
        self.store.save({'id':pid,'revision':self.record(pid)['revision'],'photos':[]})
        self.assertEqual(self.record(pid)['photoCount'],0);self.assertFalse(d.exists())
        with self.assertRaises(ValidationError):
            self.store.save({'title':'x','artist':'y','date':'2026-09-07','price':'1','currency':'JPY','photos':['data:text/html;base64,AAAA']})
        self.assertEqual(self.record(self.buy())['photoCount'],0)
    def test_cover_roundtrip(self):
        png='data:image/png;base64,'+base64.b64encode(b'\x89PNGfakecover').decode()
        rid=self.buy(cover=png)
        r=self.record(rid)
        self.assertTrue(r['cover'].startswith('/api/cover/'));self.assertTrue(r['cover'].endswith('.png'))
        f=self.store.covers_dir/r['cover'].rsplit('/',1)[1]
        self.assertEqual(f.read_bytes(),b'\x89PNGfakecover')
        # 内容寻址：同一张图全库共用一个文件
        rid2=self.buy(cover=png)
        self.assertEqual(self.record(rid2)['cover'],r['cover'])
        # 编辑不带封面 → 引用原样保留；审计快照里只有引用没有 base64
        self.store.save({'id':rid,'revision':self.record(rid)['revision'],'note':'x'})
        self.assertEqual(self.record(rid)['cover'],r['cover'])
        with self.store.connect() as db:
            rows=[row[0] for row in db.execute('SELECT data FROM audit ORDER BY id DESC LIMIT 2')]
        self.assertFalse(any('base64' in row for row in rows))
        # 换封面 → 新引用
        png2='data:image/png;base64,'+base64.b64encode(b'\x89PNGothercover').decode()
        self.store.save({'id':rid,'revision':self.record(rid)['revision'],'cover':png2})
        self.assertNotEqual(self.record(rid)['cover'],r['cover'])
        with self.assertRaises(ValidationError):
            self.store.save({'title':'x','artist':'y','date':'2026-09-07','price':'1','currency':'JPY','cover':'data:image/gif;base64,AAAA'})
    def test_schema4_migration_covers_and_audit(self):
        # 直接入库旧 schema-3 形态（data URL 封面 + 审计整图快照），重开库触发一次性迁移
        png='data:image/png;base64,'+base64.b64encode(b'\x89PNGlegacy'+b'0'*4096).decode()
        legacy={'id':'legacy1','title':'旧','artist':'数据','cover':png,'revision':1,'createdAt':'2026-01-01',
                'status':'domestic','currency':'CNY','price':'','fees':'0.00','actual':'','date':''}
        path=Path(self.tmp.name)/'db.sqlite3'
        with self.store.connect() as db:
            db.execute("INSERT OR REPLACE INTO meta VALUES('schema','3')")
            db.execute('INSERT INTO records(id,data) VALUES(?,?)',('legacy1',json.dumps(legacy)))
            db.execute('INSERT INTO audit(at,action,data) VALUES(?,?,?)',
                       ('2026-01-01','修改专辑',json.dumps({'id':'legacy1','before':legacy})))
        before=path.stat().st_size
        store=Store(path)
        r=next(x for x in store.state()['records'] if x['id']=='legacy1')
        self.assertTrue(r['cover'].startswith('/api/cover/'))
        f=store.covers_dir/r['cover'].rsplit('/',1)[1]
        self.assertEqual(f.read_bytes(),b'\x89PNGlegacy'+b'0'*4096)
        with store.connect() as db:
            self.assertEqual(db.execute("SELECT data FROM meta WHERE key='schema'").fetchone()[0],'4')
            audit=json.loads(db.execute('SELECT data FROM audit').fetchone()[0])
        self.assertNotIn('cover',audit['before'])
        self.assertLess(path.stat().st_size,before)  # VACUUM 收回了被剔除的体积
    def test_new_jpy_overseas_cny_domestic(self):
        j=self.buy();c=self.buy(currency='CNY',price='100',date='2026-09-07')
        self.assertEqual(self.record(j)['status'],'overseas');self.assertEqual(self.record(c)['status'],'domestic')
    def test_missing_rate_or_price_is_unknown_cost(self):
        a=self.buy(date='1999-01-01');b=self.buy(price='')
        self.assertIsNone(self.record(a)['cost']);self.assertIsNone(self.record(b)['cost'])
    def test_actual_priority_beats_rate(self):
        id=self.buy(actual='102.25');r=self.record(id)
        self.assertEqual(r['cost'],'112.25');self.assertNotIn('rate',r)
    def test_cny(self):self.assertEqual(self.record(self.buy(currency='CNY',price='100',date='2026-09-07'))['cost'],'110.00')
    def test_decimal_half_up(self):
        self.assertEqual(self.record(self.buy(price='1',fees='0'))['cost'],'0.05')
    def test_invalid_inputs(self):
        for kw in [{'price':'-1'},{'price':'NaN'},{'date':'2026-99-01'}]:
            with self.assertRaises(ValidationError):self.buy(**kw)
    def test_duplicate_purchase_independent(self):
        a=self.buy();b=self.buy(price='1000');sid=self.sell([a])
        self.assertEqual(self.record(b)['status'],'overseas');self.assertEqual(self.record(b)['cost'],'58.00')
    # ── sale lifecycle: shipping → complete ──
    def test_sell_then_receive(self):
        id=self.buy();sid=self.sell([id])
        self.assertEqual(self.record(id)['status'],'shipping');self.assertEqual(self.sale(sid)['status'],'shipping')
        self.assertEqual(self.sale(sid)['items'][0]['profit'],'44.00')  # 预估利润
        self.store.sale_action({'id':sid,'action':'receive','date':'2026-09-20'})
        s=self.sale(sid);self.assertEqual(s['status'],'complete');self.assertEqual(s['receivedDate'],'2026-09-20')
        self.assertEqual(self.record(id)['status'],'sold')
    def test_sell_rejects_complete_status(self):
        with self.assertRaises(ValidationError):self.store.sell({'ids':[self.buy()],'gross':'10','fees':'0','date':'2026-09-07','status':'complete'})
    def test_postage_reduces_net(self):
        id=self.buy();sid=self.sell([id],postage='5')
        self.assertEqual(self.sale(sid)['items'][0]['net'],'145.00')
    def test_no_actions_after_receive(self):
        sid=self.sell([self.buy()]);self.store.sale_action({'id':sid,'action':'receive','date':'2026-09-08'})
        for act in ({'action':'refund','refund':'10','date':'2026-09-09'},{'action':'cancel'},{'action':'receive','date':'2026-09-09'}):
            with self.assertRaises(ValidationError):self.store.sale_action({'id':sid,**act})
    def test_double_sale_rejected(self):
        id=self.buy();self.sell([id]);
        with self.assertRaises(ValidationError):self.sell([id])
        self.assertEqual(len(self.store.state()['sales']),1)
    def test_sale_cancel_restores_previous_status(self):
        id=self.buy();sid=self.sell([id]);self.store.sale_action({'id':sid,'action':'cancel'})
        self.assertEqual(self.record(id)['status'],'overseas');self.assertEqual(self.sale(sid)['status'],'cancelled')
    def test_refund_only_while_shipping(self):
        id=self.buy();sid=self.sell([id]);self.store.sale_action({'id':sid,'action':'refund','refund':'160','date':'2026-09-08','returned':True})
        self.assertEqual(self.record(id)['status'],'domestic');self.assertEqual(self.sale(sid)['items'][0]['profit'],'-10.00')
    # ── sale currency: 日元售出按售出日汇率折算人民币，原币留存 ──
    def test_sell_jpy_converts_and_keeps_original(self):
        id=self.buy()  # 成本 2000円@4.8+10 = 106.00
        sid=self.sell([id],currency='JPY',gross='1000',fees='100',postage='50')
        s=self.sale(sid)
        self.assertEqual(s['currency'],'JPY')
        self.assertEqual(s['grossOriginal'],'1000.00');self.assertEqual(s['gross'],'48.00')
        self.assertEqual(s['feesOriginal'],'100.00');self.assertEqual(s['fees'],'4.80')
        self.assertEqual(s['postageOriginal'],'50.00');self.assertEqual(s['postage'],'2.40')
        it=s['items'][0]
        self.assertEqual(it['grossOriginal'],'1000.00');self.assertEqual(it['gross'],'48.00')
        self.assertEqual(it['net'],'40.80');self.assertEqual(it['profit'],'-65.20')
    def test_sell_jpy_allocation_conserves_totals(self):
        ids=[self.buy(),self.buy()]
        sid=self.sell(ids,currency='JPY',gross='1001')
        s=self.sale(sid)
        self.assertEqual(s['gross'],'48.05')  # 1001×4.8/100 = 48.048 → 48.05
        self.assertEqual(sum(Decimal(i['gross']) for i in s['items']),Decimal('48.05'))
        self.assertEqual(sum(Decimal(i['grossOriginal']) for i in s['items']),Decimal('1001'))
    def test_sell_jpy_requires_rate(self):
        id=self.buy()
        with self.assertRaises(ValidationError):self.sell([id],currency='JPY',gross='1000',date='1999-01-01')
        self.assertEqual(self.record(id)['status'],'overseas')  # 失败不落任何写
    def test_sell_cny_stores_no_originals(self):
        id=self.buy(currency='CNY',price='100',date='2026-09-07')
        sid=self.sell([id]);s=self.sale(sid)
        self.assertEqual(s['currency'],'CNY')
        self.assertNotIn('grossOriginal',s);self.assertNotIn('grossOriginal',s['items'][0])
    def test_allocation_conserves_cents(self):
        for cents in range(1,100):
            total=Decimal(cents)/100;parts=allocate(total,[1,2,3]);self.assertEqual(sum(map(Decimal,parts)),total)
    def test_batch_buy_fee_allocation(self):
        item={'title':'A','artist':'B','date':'2026-09-07','price':'100','currency':'CNY'}
        self.store.save({'items':[item,item,item],'batchFees':'1','allocation':'equal'})
        self.assertEqual(sum(Decimal(r['cost']) for r in self.store.state()['records']),Decimal('301'))
    def test_batch_atomic(self):
        with self.assertRaises(ValidationError):self.store.save({'items':[{'title':'ok','artist':'A','date':'2026-09-07','price':10,'currency':'CNY'},{'title':''}]})
        self.assertEqual(self.store.state()['records'],[])
    # ── shipments ──
    def test_ship_adds_fee_share_and_status(self):
        a=self.buy();b=self.buy(price='1000')
        sid=self.ship([a,b])
        ra,rb=self.record(a),self.record(b)
        self.assertEqual(ra['fees'],'25.00');self.assertEqual(rb['fees'],'25.00')  # 30/2
        self.assertEqual(ra['status'],'transit');self.assertEqual(rb['status'],'transit')
        sh=next(s for s in self.store.state()['shipments'] if s['id']==sid)
        self.assertEqual(sh['status'],'transit');self.assertEqual(sh['cost'],'30.00')
    def test_ship_cost_in_album_cost(self):
        a=self.buy();self.ship([a])
        # 2000*4.8/100 + 10 + 运费30（单张不均摊）= 136.00
        self.assertEqual(self.record(a)['cost'],'136.00')
    def test_ship_requires_overseas(self):
        c=self.buy(currency='CNY',price='100',date='2026-09-07')
        with self.assertRaises(ValidationError):self.ship([c])
    def test_ship_jpy_converts_at_day_rate(self):
        a=self.buy();b=self.buy()
        sid=self.ship([a,b],currency='JPY',cost='1000')  # 1000円 × 4.8/100 = ¥48
        sh=next(s for s in self.store.state()['shipments'] if s['id']==sid)
        self.assertEqual(sh['cost'],'48.00')
        self.assertEqual(sh['currency'],'JPY');self.assertEqual(sh['costOriginal'],'1000.00')
        self.assertEqual(self.record(a)['fees'],'34.00')  # 买入 fees 10 + 均摊 24
        self.assertEqual([i['feeOriginal'] for i in sh['items']],['500.00','500.00'])  # 日元原额分摊
    def test_ship_jpy_without_rate_rejected(self):
        a=self.buy()
        with self.assertRaises(ValidationError):self.ship([a],currency='JPY',cost='100',date='2026-02-01')
    def test_shipment_edit_currency_recalculates(self):
        a=self.buy();sid=self.ship([a])  # 默认人民币 30 → fees 40
        self.store.update_shipment({'id':sid,'currency':'JPY','cost':'1000'})
        sh=next(s for s in self.store.state()['shipments'] if s['id']==sid)
        self.assertEqual(sh['cost'],'48.00');self.assertEqual(sh['costOriginal'],'1000.00')
        self.assertEqual(sh['items'][0]['feeOriginal'],'1000.00')
        self.assertEqual(self.record(a)['fees'],'58.00')  # 40 + 48 − 30
        self.assertEqual(self.record(a)['cost'],'154.00')  # 96 折算 + 58 fees
    def test_arrive_then_rollback(self):
        a=self.buy();sid=self.ship([a])
        self.store.shipment_action({'id':sid,'action':'arrive','date':'2026-09-18'})
        self.assertEqual(self.record(a)['status'],'domestic')
        sh=next(s for s in self.store.state()['shipments'] if s['id']==sid)
        self.assertEqual(sh['status'],'arrived');self.assertEqual(sh['arrivedDate'],'2026-09-18')
        self.store.shipment_action({'id':sid,'action':'undo_arrive'})
        self.assertEqual(self.record(a)['status'],'transit')
        sh=next(s for s in self.store.state()['shipments'] if s['id']==sid)
        self.assertEqual(sh['status'],'transit');self.assertEqual(sh['arrivedDate'],'')
    def test_rollback_blocked_when_sold(self):
        a=self.buy();sid=self.ship([a])
        self.store.shipment_action({'id':sid,'action':'arrive','date':'2026-09-18'})
        sale_id=self.sell([a])
        with self.assertRaises(ValidationError):self.store.shipment_action({'id':sid,'action':'undo_arrive'})
        self.store.sale_action({'id':sale_id,'action':'cancel'})
        self.store.shipment_action({'id':sid,'action':'undo_arrive'})  # now ok
        self.assertEqual(self.record(a)['status'],'transit')
    def test_cancel_shipment_reverts_fees(self):
        a=self.buy();sid=self.ship([a])
        self.assertEqual(self.record(a)['cost'],'136.00')
        self.store.shipment_action({'id':sid,'action':'cancel'})
        r=self.record(a)
        self.assertEqual(r['status'],'overseas');self.assertEqual(r['fees'],'10.00');self.assertEqual(r['cost'],'106.00')
        self.assertNotIn('shipmentId',r)
    def test_update_shipment_cost_reallocates(self):
        a=self.buy();b=self.buy(price='1000');sid=self.ship([a,b])
        self.store.update_shipment({'id':sid,'cost':'50','method':'船运'})
        self.assertEqual(self.record(a)['fees'],'35.00');self.assertEqual(self.record(b)['fees'],'35.00')
    def test_to_overseas_bulk(self):
        c=self.buy(currency='CNY',price='100',date='2026-09-07')
        self.store.bulk({'action':'to_overseas','ids':[c]})
        self.assertEqual(self.record(c)['status'],'overseas')
        with self.assertRaises(ValidationError):self.store.bulk({'action':'to_overseas','ids':[c]})
    def test_delete_blocked_in_transit(self):
        a=self.buy();self.ship([a])
        with self.assertRaises(ValidationError):self.store.bulk({'action':'delete','ids':[a]})
    # ── 上架标记（国内库存的附加标记，只经 bulk 写入）──
    def test_listed_mark_roundtrip(self):
        c=self.buy(currency='CNY',price='100',date='2026-09-07')
        self.assertNotIn('listed',self.record(c))
        self.store.bulk({'action':'list','ids':[c]})
        self.assertTrue(self.record(c)['listed'])
        sid=self.sell([c])  # 上架中的专辑照常售出
        self.assertEqual(self.record(c)['status'],'shipping')
        self.store.sale_action({'id':sid,'action':'cancel'})
        r=self.record(c)
        self.assertEqual(r['status'],'domestic');self.assertTrue(r['listed'])  # 撤销后标记保留
        self.store.bulk({'action':'unlist','ids':[c]})
        self.assertNotIn('listed',self.record(c))
    def test_listed_overseas_too(self):
        j=self.buy()  # 海外库存（如メルカリ在售）
        self.store.bulk({'action':'list','ids':[j]})
        self.assertTrue(self.record(j)['listed'])
        sid=self.sell([j])  # 海外上架中直接售出
        self.assertEqual(self.record(j)['status'],'shipping')
        self.store.sale_action({'id':sid,'action':'cancel'})
        r=self.record(j)
        self.assertEqual(r['status'],'overseas');self.assertTrue(r['listed'])
        self.store.bulk({'action':'unlist','ids':[j]})
        self.assertNotIn('listed',self.record(j))
    def test_listed_rejected_off_inventory(self):
        a=self.buy();shid=self.ship([a])
        with self.assertRaises(ValidationError):self.store.bulk({'action':'list','ids':[a]})  # 在途
        self.store.shipment_action({'id':shid,'action':'arrive','date':'2026-09-18'})
        sid=self.sell([a]);self.store.sale_action({'id':sid,'action':'receive','date':'2026-09-20'})
        with self.assertRaises(ValidationError):self.store.bulk({'action':'list','ids':[a]})  # 已售出
        b=self.buy();self.store.bulk({'action':'delete','ids':[b]})
        with self.assertRaises(ValidationError):self.store.bulk({'action':'list','ids':[b]})  # 回收站
    def test_listed_not_writable_via_save(self):
        c=self.buy(currency='CNY',price='100',date='2026-09-07')
        self.store.bulk({'action':'list','ids':[c]})
        r=dict(self.record(c));r['listed']=False
        self.store.save(r)
        self.assertTrue(self.record(c)['listed'])  # 编辑表单改不了上架标记
        self.assertNotIn('listed',self.record(self.buy(currency='CNY',price='100',date='2026-09-07')))
    def test_to_overseas_clears_listed(self):
        c=self.buy(currency='CNY',price='100',date='2026-09-07')
        self.store.bulk({'action':'list','ids':[c]})
        self.store.bulk({'action':'to_overseas','ids':[c]})
        r=self.record(c)
        self.assertEqual(r['status'],'overseas');self.assertNotIn('listed',r)
    def test_csv_export_lists_listed(self):
        from server.export_csv import albums_csv
        c=self.buy(currency='CNY',price='100',date='2026-09-07')
        self.store.bulk({'action':'list','ids':[c]})
        rows=albums_csv(self.store.state()).decode().splitlines()
        self.assertIn('上架',rows[0]);self.assertIn(',是,',rows[1])
    # ── misc ──
    def test_edit_conflict_and_profit_recalc(self):
        id=self.buy();r=self.record(id);sid=self.sell([id]);
        with self.assertRaises(ValidationError):self.store.save(r)
        r=self.record(id);self.store.save({**r,'price':'2500'});self.assertEqual(self.sale(sid)['items'][0]['profit'],'20.00')
    def test_rate_fields_never_persist(self):
        id=self.buy();r=dict(self.record(id));r['rate']='9.9'
        self.store.save(r);self.assertEqual(self.record(id)['cost'],'106.00')
    def test_import_idempotent_raw_preserved(self):
        source=[{'id':'old','title':'日文','artist':'歌手','note':'原始感想','rawRemark':'記録','purchase':{'date':'2026-01-01','currency':'RMB','priceValue':30}}]
        self.store.import_data(source);self.store.import_data(source);b=self.store.backup()
        self.assertEqual(len(b['records']),1);self.assertEqual(b['records'][0]['original'],source[0]);self.assertEqual(b['records'][0]['status'],'domestic')
    def test_backup_restore_roundtrip_with_shipments(self):
        a=self.buy();b=self.buy(price='1000');self.ship([a])
        sid=self.sell([b]);self.store.sale_action({'id':sid,'action':'receive','date':'2026-09-20'})
        backup=self.store.backup();self.assertEqual(len(backup['shipments']),1)
        self.buy(title='extra');self.store.restore_backup(backup)
        restored=self.store.backup()
        self.assertEqual(restored['records'],backup['records']);self.assertEqual(restored['sales'],backup['sales']);self.assertEqual(restored['shipments'],backup['shipments'])
    def test_legacy_schema1_backup_upgrades(self):
        legacy={'format':'album-ledger','schema':1,'createdAt':'2026-09-01T00:00:00',
            'records':[{'id':'a1','title':'T','artist':'A','date':'2026-01-01','price':'1000.00','currency':'JPY','rate':'4.7','actual':'','fees':'0.00','note':'','tradeNote':'','version':'','condition':'','tag':'','storage':'','releaseYear':'','rawRemark':'','cover':'','status':'review','revision':1,'createdAt':'2026-09-01T00:00:00'}],
            'sales':[{'id':'s1','date':'2026-02-01','receivedDate':'2026-02-01','status':'pending','gross':'80','fees':'2','note':'','channel':'闲鱼','items':[{'recordId':'a1','gross':'80','fees':'2','refund':'0'}]}],
            'audit':[],'settings':{}}
        self.store.restore_backup(legacy)
        rec=self.record('a1');sale=self.sale('s1')
        self.assertEqual(rec['status'],'domestic');self.assertNotIn('rate',rec);self.assertEqual(sale['status'],'complete')
    def test_real_import(self):
        # 框架仓库不含个人数据；把自己的 albums.json 放进 data/ 才跑此测试
        src=Path(__file__).parents[1]/'data'/'albums.json'
        if not src.exists(): return self.skipTest('data/albums.json 不存在')
        self.store.rates=FakeRates({})
        r=self.store.import_data(json.loads(src.read_text()))
        self.assertGreater(r['count'],0)
        self.assertEqual(len(self.store.state()['records']),r['count'])
    # ── 退役的 RYM 直达：历史数据保留，不再生成新绑定 ──
    def test_rym_settings_preserved_and_roundtrip(self):
        # meta 里的历史 rym 数据原样保留（只读通用路径），不删除、不覆盖、不迁移
        with self.store.connect() as db:
            db.execute("INSERT OR REPLACE INTO meta VALUES('rym-token',?)", ('"tok-123"',))
            db.execute("INSERT OR REPLACE INTO meta VALUES('rym-links',?)",
                       ('{"米津玄師": "https://rateyourmusic.com/artist/kenshi_yonezu"}',))
        self.assertFalse(hasattr(self.store, 'bind_artist'))  # 旧绑定入口已退役
        b = self.store.backup()
        self.assertEqual(b['settings']['rym-links']['米津玄師'], 'https://rateyourmusic.com/artist/kenshi_yonezu')
        self.assertEqual(b['settings']['rym-token'], 'tok-123')
        other = Store(Path(self.tmp.name) / 'other.sqlite3')
        other.restore_backup(b)  # 旧备份继续可恢复这些设置
        with other.connect() as db:
            links = json.loads(db.execute("SELECT data FROM meta WHERE key='rym-links'").fetchone()[0])
        self.assertEqual(links['米津玄師'], 'https://rateyourmusic.com/artist/kenshi_yonezu')

class RateServiceTests(unittest.TestCase):
    def test_weekend_rolls_back(self):
        svc=RateService(fetch=lambda s,e:{'2026-01-09':'4.429'})
        self.assertEqual(svc.get('2026-01-11'),'4.429')  # Sunday → Friday quote
    def test_unavailable_returns_none(self):
        from rates import RateUnavailable
        def boom(s,e):raise RateUnavailable('down')
        svc=RateService(fetch=boom)
        self.assertIsNone(svc.get('2026-01-09'))
    def test_cached_second_call_skips_fetch(self):
        calls=[]
        def fetch(s,e):
            calls.append(1);return {'2026-03-02':'4.5'}
        svc=RateService(fetch=fetch)
        self.assertEqual(svc.get('2026-03-02'),'4.5')
        self.assertEqual(svc.get('2026-03-02'),'4.5')
        self.assertEqual(len(calls),1)
    def test_state_after_edit_reuses_persisted_rates(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'rates.sqlite3'
            RateService(path,fetch=lambda s,e:{'2026-03-02':'4.5'}).warm(['2026-03-02'])
            def unexpected(s,e):
                self.fail('cached purchase dates must not fetch again')
            rates=RateService(path,fetch=unexpected)
            store=Store(Path(folder)/'albums.sqlite3',rates)
            rid=store.save({'title':'测试专辑','artist':'艺人','currency':'JPY',
                           'date':'2026-03-02','price':'2000','fees':'10'})['ids'][0]
            record=store.state()['records'][0]
            self.assertEqual(record['cost'],'100.00')
            store.save({**record,'note':'修改备注'})
            saved=store.state()['records'][0]
            self.assertEqual(saved['id'],rid)
            self.assertEqual(saved['note'],'修改备注')
            self.assertEqual(saved['cost'],'100.00')
    def test_warm_reuses_successful_weekend_and_holiday_lookup(self):
        calls=[]
        def fetch(s,e):
            calls.append((s,e));return {'2026-01-09':'4.429'}
        svc=RateService(fetch=fetch)
        dates=['2026-01-11','2026-01-12']
        for _ in range(3):
            svc.warm(dates)
            for d in dates:self.assertEqual(svc.get(d),'4.429')
        self.assertEqual(len(calls),1)
    def test_warm_fetches_new_date_instead_of_reusing_older_quote(self):
        calls=[]
        def fetch(s,e):
            calls.append((s,e));return {e:'4.6' if e=='2026-03-03' else '4.5'}
        svc=RateService(fetch=fetch)
        svc.warm(['2026-03-02'])
        svc.warm(['2026-03-02','2026-03-03'])
        self.assertEqual(svc.get('2026-03-02'),'4.5')
        self.assertEqual(svc.get('2026-03-03'),'4.6')
        self.assertEqual(len(calls),2)
    def test_warm_empty_result_keeps_missing_cost_without_repeated_fetch(self):
        calls=[]
        def fetch(s,e):calls.append((s,e));return {}
        with tempfile.TemporaryDirectory() as folder:
            svc=RateService(fetch=fetch)
            store=Store(Path(folder)/'albums.sqlite3',svc)
            store.save({'title':'测试专辑','artist':'艺人','currency':'JPY',
                        'date':'2026-03-02','price':'2000'})
            for _ in range(2):self.assertIsNone(store.state()['records'][0]['cost'])
            self.assertEqual(len(calls),1)
    def test_failed_warm_can_retry(self):
        from rates import RateUnavailable
        calls=[]
        def fetch(s,e):
            calls.append((s,e))
            if len(calls)==1:raise RateUnavailable('down')
            return {'2026-03-02':'4.5'}
        svc=RateService(fetch=fetch)
        svc.warm(['2026-03-02'])
        svc.warm(['2026-03-02'])
        self.assertEqual(svc.get('2026-03-02'),'4.5')
        self.assertEqual(len(calls),2)
    def test_warm_rechecks_today_when_quote_was_not_published(self):
        today=date.today().isoformat()
        yesterday=(date.today()-timedelta(days=1)).isoformat()
        calls=[]
        def fetch(s,e):
            calls.append((s,e))
            return {yesterday:'4.5'} if len(calls)==1 else {today:'4.6'}
        svc=RateService(fetch=fetch)
        with patch('rates.monotonic',return_value=1000):
            svc.warm([today])
            self.assertEqual(svc.get(today),'4.5')
        with patch('rates.monotonic',return_value=1299):svc.warm([today])
        self.assertEqual(len(calls),1)
        with patch('rates.monotonic',return_value=1301):svc.warm([today])
        self.assertEqual(svc.get(today),'4.6')
        self.assertEqual(len(calls),2)
    def test_empty_lookup_can_retry_after_cooldown(self):
        calls=[]
        def fetch(s,e):
            calls.append((s,e));return {} if len(calls)==1 else {'2026-03-02':'4.5'}
        svc=RateService(fetch=fetch)
        with patch('rates.monotonic',return_value=1000):
            svc.warm(['2026-03-02'])
            self.assertIsNone(svc.get('2026-03-02'))
        with patch('rates.monotonic',return_value=1301):svc.warm(['2026-03-02'])
        self.assertEqual(svc.get('2026-03-02'),'4.5')
        self.assertEqual(len(calls),2)

if __name__=='__main__':unittest.main()
