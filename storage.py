"""SQLite persistence. All multi-record writes are transactional.

Record status: overseas (held in Japan; optional `listed` mark, e.g. Mercari)
/ transit (in a shipment package) / domestic (home; same optional `listed`
mark, e.g. Xianyu) / shipping (sold, on the way to buyer) / sold / trash.

Shipments group albums sent in one package: creating one stamps an equal
share of the postage onto each album's fees (part of acquisition cost); it
can be rolled back at any step while albums haven't moved on.
Sales start at 'shipping'; only 确认收货 turns them into realized cash ('sold').
"""
import json, sqlite3, uuid, base64, re, shutil, secrets
from pathlib import Path
from datetime import datetime
from urllib.parse import urlsplit
from domain import ValidationError, clean_record, clean_modules, MODULE_NAMES, cost, number, money, day, allocate, STATUSES
from covers import normalized, artist_variants
from decimal import Decimal

SCHEMA = 3
SHIPMENT_STATUSES = ('transit', 'arrived', 'cancelled')
SALE_STATUSES = ('shipping', 'complete', 'cancelled', 'returned', 'refunded')
PHOTO_RE = re.compile(r'^data:image/(jpeg|png|webp);base64,')

def rym_artist_url(url):
    """校验并归一 RYM 艺人页链接；非艺人页返回 None。"""
    p = urlsplit(str(url))
    if p.scheme != 'https' or p.hostname not in ('rateyourmusic.com', 'www.rateyourmusic.com'): return None
    parts = [s for s in p.path.split('/') if s]
    if len(parts) != 2 or parts[0] != 'artist': return None
    slug = parts[1]
    if not slug or len(slug) > 120 or any(c in slug for c in '@?#&%. '): return None
    return 'https://rateyourmusic.com/artist/' + slug
PHOTO_MIME = {'jpeg': '.jpg', 'png': '.png', 'webp': '.webp'}
MAX_PHOTOS = 9

def uid(): return uuid.uuid4().hex

def now(): return datetime.now().isoformat(timespec='seconds')

def dumps(x): return json.dumps(x, ensure_ascii=False)

def default_status(currency): return 'domestic' if currency == 'CNY' else 'overseas'

class Store:
    def __init__(self, path, rates=None):
        self.path = Path(path); self.path.parent.mkdir(parents=True, exist_ok=True)
        self.photos_dir = self.path.parent / 'photos'
        self.rates = rates
        with self.connect() as db:
            db.executescript('''CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS shipments(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT, action TEXT, data TEXT);
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, data TEXT NOT NULL);''')
        self.migrate()
    def connect(self):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        return db
    def rows(self, db, table): return [json.loads(r['data']) for r in db.execute(f'SELECT data FROM {table}')]
    def get(self, db, table, id):
        row = db.execute(f'SELECT data FROM {table} WHERE id=?',(id,)).fetchone()
        if not row: raise ValidationError('记录不存在，请刷新页面')
        return json.loads(row['data'])
    def put(self, db, table, r):
        db.execute(f'INSERT OR REPLACE INTO {table}(id,data) VALUES(?,?)',(r['id'],dumps(r)))
    def audit(self, db, action, data):
        db.execute('INSERT INTO audit(at,action,data) VALUES(?,?,?)',(now(),action,dumps(data)))
    def migrate(self):
        """One-way upgrades; idempotent. Schema 1: review/manual rates. Schema 3: shipments."""
        with self.connect() as db:
            version = db.execute("SELECT data FROM meta WHERE key='schema'").fetchone()
            if version and json.loads(version[0]) >= SCHEMA: return
            for r in self.rows(db,'records'):
                changed = False
                if r.get('status') == 'review':
                    r['status'] = 'domestic'; changed = True
                if r.get('previousStatus') == 'review':
                    r['previousStatus'] = 'domestic'; changed = True
                for k in ('rate','rateSource'):
                    if k in r: r.pop(k); changed = True
                if changed: self.put(db,'records',r)
            db.execute("INSERT OR REPLACE INTO meta VALUES('schema',?)",(dumps(SCHEMA),))
    def backup(self):
        with self.connect() as db:
            return {'format':'album-ledger','schema':SCHEMA,'createdAt':now(),
                'records':self.rows(db,'records'),'sales':self.rows(db,'sales'),
                'shipments':self.rows(db,'shipments'),
                'audit':[dict(r) for r in db.execute('SELECT * FROM audit')],
                'settings':{r['key']:json.loads(r['data']) for r in db.execute('SELECT * FROM meta')}}
    def checkpoint(self):
        folder=self.path.parent/'backups';folder.mkdir(exist_ok=True)
        name=folder/(datetime.now().strftime('%Y%m%d-%H%M%S-%f')+'.json')
        name.write_text(dumps(self.backup()),encoding='utf-8')
    def record_rates(self, records):
        out = {}
        days = {r['date'] for r in records if r.get('currency')=='JPY' and r.get('date') and r.get('actual','')==''}
        if self.rates and days:
            self.rates.warm(sorted(days))
            out = {d: self.rates.get(d) for d in days}
        return out
    def state(self):
        b=self.backup()
        enabled = b['settings'].get('modules-v1')
        b['modules'] = {'enabled': clean_modules(enabled) if enabled is not None else {k: True for k in MODULE_NAMES},
                        'configured': enabled is not None,
                        'needsSetup': enabled is None and not any(b[k] for k in ('records', 'sales', 'shipments'))}
        rates=self.record_rates(b['records'])
        for r in b['records']:
            rate = rates.get(r.get('date')) if r.get('currency')=='JPY' and r.get('date') and r.get('actual','')=='' else None
            if rate: r['rate']=str(rate)
            c=cost(r, rate)
            r['cost']=money(c) if c is not None else None
            r.pop('original',None)
        costs={r['id']:r['cost'] for r in b['records']}
        for s in b['sales']:
            for item in s['items']:
                c=Decimal(costs[item['recordId']]) if costs.get(item['recordId']) not in (None,'') else None
                net=Decimal(item['gross'])-Decimal(item['fees'])-Decimal(item.get('postage','0'))-Decimal(item.get('refund','0'))
                item['net']=money(net)
                # Returned stock retains its acquisition cost; sale shows only residual loss.
                p=net if s['status']=='returned' else (net-c if c is not None else None)
                item['profit']=money(p) if p is not None else None
        b['audit']=b['audit'][-100:]
        if self.rates: b['rateService']=self.rates.status()
        return b
    def set_modules(self, enabled):
        enabled = clean_modules(enabled)
        with self.connect() as db:
            before = self.meta_get(db, 'modules-v1')
            db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)', ('modules-v1', dumps(enabled)))
            self.audit(db, '调整功能模块', {'before': before, 'after': enabled})
        return {'ok': True, 'enabled': enabled}
    def require_module(self, name):
        with self.connect() as db:
            enabled = self.meta_get(db, 'modules-v1')
        if enabled is not None and not clean_modules(enabled)[name]:
            label = {'acquisition': '购入记录', 'trading': '二手交易', 'circulation': '海外周转'}[name]
            raise ValidationError(f'请先在设置中启用「{label}」模块')
    def import_preview(self, source):
        if not isinstance(source,list) or len(source)>10000: raise ValidationError('请选择专辑 JSON 数组文件，最多 10000 条')
        with self.connect() as db:
            existing={r.get('sourceId') for r in self.rows(db,'records')}
            modules = self.meta_get(db, 'modules-v1')
        seen=set();good=[];errors=[];duplicates=0
        for i,a in enumerate(source):
            try:
                if not isinstance(a,dict) or not a.get('id'): raise ValidationError('缺少原始 ID')
                sid=str(a['id'])
                if sid in seen: raise ValidationError('文件内 ID 重复')
                seen.add(sid)
                if sid in existing: duplicates+=1;continue
                p=a.get('purchase',{})
                r=clean_record({'title':a.get('title'),'artist':a.get('artist'),'date':p.get('date'),
                    'price':p.get('priceValue'),'currency':p.get('currency'),'location':p.get('location'),
                    'note':a.get('note',''),'rawRemark':a.get('rawRemark',''),'releaseYear':a.get('releaseYear','')})
                status = default_status(r['currency']) if modules is None or modules['circulation'] else 'domestic'
                r.update(id=uid(),sourceId=sid,original=a,status=status,revision=1,createdAt=now())
                good.append(r)
            except (ValidationError,TypeError,AttributeError) as e: errors.append(f'第 {i+1} 条：{e}')
        return {'records':good,'skipped':duplicates,'errors':errors}
    def import_data(self, source):
        preview=self.import_preview(source)
        if preview['errors']: raise ValidationError('；'.join(preview['errors'][:5]))
        self.checkpoint()
        with self.connect() as db:
            for r in preview['records']: self.put(db,'records',r)
            self.audit(db,'导入专辑',{'count':len(preview['records']),'skipped':preview['skipped']})
        return {'count':len(preview['records']),'skipped':preview['skipped']}
    def prepare_photos(self, rid, entries):
        """Validate photo entries against the current set; returns [(ext, bytes)].

        Entries are indexes into the existing photo set (keep) or data URLs (new).
        Raises before any filesystem change, so save() can roll back cleanly.
        """
        if not isinstance(entries, list): raise ValidationError('照片数据不正确')
        d = self.photos_dir / rid
        existing = sorted([p for p in d.iterdir() if p.is_file()], key=lambda p: int(p.stem)) if d.exists() else []
        plan = []
        for e in entries:
            if len(plan) >= MAX_PHOTOS: raise ValidationError(f'每张专辑最多 {MAX_PHOTOS} 张照片')
            if isinstance(e, int) and not isinstance(e, bool):
                if not 0 <= e < len(existing): raise ValidationError('照片序号不存在，请刷新页面后重试')
                plan.append((existing[e].suffix, existing[e].read_bytes()))
            elif isinstance(e, str):
                m = PHOTO_RE.match(e)
                if not m: raise ValidationError('照片格式不正确，请使用 JPG/PNG/WebP 图片')
                try: raw = base64.b64decode(e[m.end():], validate=True)
                except Exception: raise ValidationError('照片数据损坏，请重新选择图片')
                if len(raw) > 8 * 1024 * 1024: raise ValidationError('单张照片过大，请重拍或压缩后再上传')
                plan.append((PHOTO_MIME[m.group(1)], raw))
            else: raise ValidationError('照片数据不正确')
        return plan
    def apply_photos(self, rid, plan):
        d = self.photos_dir / rid
        if d.exists(): shutil.rmtree(d)
        if plan:
            d.mkdir(parents=True, exist_ok=True)
            for i, (ext, raw) in enumerate(plan): (d / f'{i}{ext}').write_bytes(raw)
    def save(self, data):
        items=data.get('items')
        if items is None: items=[data]
        if not items or len(items)>500: raise ValidationError('一次可录入 1–500 张专辑')
        if 'batchFees' in data:
            shares=allocate(number(data['batchFees'],'整批额外费用'), [number(i.get('price'),'买入金额', optional=True) or 1 for i in items] if data.get('allocation')=='price' else [1]*len(items))
            items=[{**i,'fees':f} for i,f in zip(items,shares)]
        with self.connect() as db:
            result=[];plans=[]
            modules = self.meta_get(db, 'modules-v1')
            for item in items:
                photos=item.pop('photos',None);item.pop('photoCount',None)
                if item.get('id'):
                    old=self.get(db,'records',item['id'])
                    if item.get('revision')!=old['revision']: raise ValidationError('记录已变更，请关闭详情并重新打开')
                    r=clean_record({**old,**item})
                    for k in ('id','status','sourceId','original','saleId','shipmentId','previousStatus','createdAt','listed'):
                        if k in old: r[k]=old[k]
                        else: r.pop(k,None)
                    r['revision']=old['revision']+1
                    self.audit(db,'修改专辑',{'id':r['id'],'before':old})
                else:
                    r=clean_record({'currency': 'CNY', **item} if modules is not None and not modules['circulation'] else item)
                    status=r.get('status') if r.get('status') in ('overseas','domestic') else default_status(r['currency'])
                    if modules is not None and not modules['circulation']:
                        if item.get('status') == 'overseas':
                            raise ValidationError('请先在设置中启用「海外周转」模块')
                        status = 'domestic'
                    r.update(id=uid(),status=status,revision=1,createdAt=now())
                    self.audit(db,'添加专辑' if modules is not None and not modules['acquisition'] else '记录买入',{'id':r['id'],'title':r['title']})
                if photos is not None:
                    plan=self.prepare_photos(r['id'],photos)
                    plans.append((r['id'],plan))
                    r['photoCount']=len(plan)
                elif item.get('id'): r['photoCount']=old.get('photoCount',0)
                else: r['photoCount']=0
                self.put(db,'records',r);result.append(r['id'])
                # 专辑笔记在同专辑所有副本间共享：保存时传播给同名同艺人的其他记录
                if item.get('id') and 'noteAlbum' in item:
                    cur=db.execute("UPDATE records SET data=json_set(data,'$.noteAlbum',?) WHERE id!=? AND json_extract(data,'$.title')=? AND json_extract(data,'$.artist')=?",(r.get('noteAlbum',''),r['id'],r['title'],r['artist']))
                    if cur.rowcount:self.audit(db,'同步专辑笔记',{'id':r['id'],'title':r['title'],'siblings':cur.rowcount})
        for rid,plan in plans:self.apply_photos(rid,plan)
        return {'ids':result}
    def bulk(self, data):
        ids=list(dict.fromkeys(data.get('ids',[])));action=data.get('action')
        if not ids: raise ValidationError('请先选择专辑')
        if action in ('list', 'unlist'): self.require_module('trading')
        if action == 'to_overseas': self.require_module('circulation')
        self.checkpoint()
        with self.connect() as db:
            for id in ids:
                r=self.get(db,'records',id);old=dict(r)
                if action=='to_overseas':
                    if r['status']!='domestic': raise ValidationError('只有国内库存的专辑能调回海外')
                    r['status']='overseas';r.pop('shipmentId',None);r.pop('listed',None)
                elif action=='list':
                    if r['status'] not in ('overseas','domestic'): raise ValidationError('只有库存中的专辑能标记上架')
                    r['listed']=True
                elif action=='unlist':
                    if r['status'] not in ('overseas','domestic'): raise ValidationError('只有库存中的专辑能取消上架')
                    r.pop('listed',None)
                elif action=='delete':
                    if r['status'] not in ('overseas','domestic'): raise ValidationError('在途或已售的专辑不能移除；请先处理包裹或交易')
                    r['previousStatus']=r['status'];r['status']='trash'
                elif action=='restore':
                    if r['status']!='trash': raise ValidationError('只能恢复回收站记录')
                    r['status']=r.get('previousStatus','domestic')
                else: raise ValidationError('不支持的操作')
                r['revision']+=1;self.put(db,'records',r);self.audit(db,action,{'id':id,'before':old})
        return {'count':len(ids)}
    # ── shipments (打包运输) ──
    def to_cny(self,amount,currency,date):
        """运费折算为人民币；日元按当日每100円汇率。缺汇率时拒绝：运费要立即均摊进成本，不能挂起待定。"""
        if currency=='CNY': return amount
        rate=self.rates.get(date) if self.rates else None
        if rate in ('',None): raise ValidationError('暂无当日汇率，无法折算日元运费；可直接填人民币金额')
        return Decimal(str(amount))*Decimal(str(rate))/100
    def ship(self,data):
        self.require_module('circulation')
        ids=list(dict.fromkeys(data.get('ids',[])))
        if not ids: raise ValidationError('请选择要运输的专辑')
        currency=data.get('currency') or 'CNY'
        if currency not in ('CNY','JPY'): raise ValidationError('币种不支持')
        cost_v=number(data.get('cost',0),'运费')
        method=str(data.get('method','')).strip()
        if not method or len(method)>50: raise ValidationError('请填写运输方式')
        date=day(data.get('date'),'发货日期')
        cny=self.to_cny(cost_v,currency,date)
        s={'id':uid(),'method':method,'cost':money(cny),'date':date,
            'currency':currency,'costOriginal':money(cost_v) if currency=='JPY' else '',
            'note':str(data.get('note','')),'status':'transit','arrivedDate':'','createdAt':now(),
            'items':[]}
        with self.connect() as db:
            rs=[self.get(db,'records',id) for id in ids]
            if any(r['status']!='overseas' for r in rs): raise ValidationError('只有海外库存的专辑能打包运输')
            shares=allocate(cny,[1]*len(rs))
            orig_shares=allocate(cost_v,[1]*len(rs)) if currency=='JPY' else shares
            s['items']=[{'recordId':r['id'],'fee':f,'feeOriginal':o} for r,f,o in zip(rs,shares,orig_shares)]
            for r,f in zip(rs,shares):
                r['fees']=money(Decimal(r.get('fees') or 0)+Decimal(f))
                r['previousStatus']='overseas';r['status']='transit';r['shipmentId']=s['id'];r['revision']+=1
                self.put(db,'records',r)
            self.put(db,'shipments',s);self.audit(db,'打包运输',{'id':s['id'],'count':len(rs),'cost':s['cost']})
        return {'id':s['id']}
    def shipment_action(self,data):
        self.require_module('circulation')
        with self.connect() as db:
            s=self.get(db,'shipments',data.get('id'));old=json.loads(dumps(s));action=data.get('action')
            if action=='arrive':
                if s['status']!='transit': raise ValidationError('只有在途包裹能签收')
                s['status']='arrived';s['arrivedDate']=day(data.get('date'),'签收日期')
                for item in s['items']:
                    r=self.get(db,'records',item['recordId'])
                    if r['status']!='transit': raise ValidationError('包裹状态与专辑不一致，请刷新页面')
                    r['status']='domestic';r['revision']+=1;self.put(db,'records',r)
            elif action=='undo_arrive':
                if s['status']!='arrived': raise ValidationError('只有已签收的包裹能回滚')
                for item in s['items']:
                    r=self.get(db,'records',item['recordId'])
                    if r['status']!='domestic': raise ValidationError('其中有专辑已售出或移除，无法回滚；请先处理对应交易')
                s['status']='transit';s['arrivedDate']=''
                for item in s['items']:
                    r=self.get(db,'records',item['recordId']);r['status']='transit';r['revision']+=1;self.put(db,'records',r)
            elif action=='cancel':
                if s['status']!='transit': raise ValidationError('包裹已签收，不能撤销运输')
                for item in s['items']:
                    r=self.get(db,'records',item['recordId'])
                    if r['status']=='transit':
                        r['fees']=money(max(Decimal(r.get('fees') or 0)-Decimal(item['fee']),Decimal('0')))
                        r['status']='overseas';r.pop('shipmentId',None);r['revision']+=1;self.put(db,'records',r)
                s['status']='cancelled'
            else: raise ValidationError('不支持的操作')
            self.put(db,'shipments',s);self.audit(db,'运输 '+action,{'before':old,'after':s})
        return {'ok':True}
    def update_shipment(self,data):
        self.require_module('circulation')
        with self.connect() as db:
            s=self.get(db,'shipments',data.get('id'));old=json.loads(dumps(s))
            if s['status']=='cancelled': raise ValidationError('已撤销的包裹不能修改')
            if 'method' in data:
                m=str(data['method']).strip()
                if not m or len(m)>50: raise ValidationError('请填写运输方式')
                s['method']=m
            if 'note' in data: s['note']=str(data['note'])
            if 'date' in data: s['date']=day(data['date'],'发货日期')
            if 'cost' in data or 'currency' in data:
                currency=data.get('currency') or s.get('currency') or 'CNY'
                if currency not in ('CNY','JPY'): raise ValidationError('币种不支持')
                orig=number(data['cost'],'运费') if 'cost' in data else Decimal(s.get('costOriginal') or s['cost'])
                new=self.to_cny(orig,currency,s['date'])
                shares=allocate(new,[1]*len(s['items']))
                orig_shares=allocate(orig,[1]*len(s['items'])) if currency=='JPY' else shares
                for item,share,o_share in zip(s['items'],shares,orig_shares):
                    r=self.get(db,'records',item['recordId'])
                    r['fees']=money(Decimal(r.get('fees') or 0)+Decimal(share)-Decimal(item['fee']))
                    r['revision']+=1;self.put(db,'records',r)
                    item['fee']=share;item['feeOriginal']=o_share
                s['cost']=money(new);s['currency']=currency
                if currency=='JPY': s['costOriginal']=money(orig)
                else: s.pop('costOriginal',None)
            self.put(db,'shipments',s);self.audit(db,'修改运输',{'before':old,'after':s})
        return {'ok':True}
    # ── sales ──
    def sell(self,data):
        self.require_module('trading')
        ids=list(dict.fromkeys(data.get('ids',[])))
        if not ids: raise ValidationError('请选择要出售的专辑')
        gross=number(data.get('gross'),'成交价')
        fees=number(data.get('fees',0),'平台扣费')
        postage=number(data.get('postage',0),'寄出运费')
        if data.get('status') not in (None,'shipping'): raise ValidationError('售出后需买家确认收货才到账')
        address=str(data.get('address','')).strip()
        if len(address)>500: raise ValidationError('地址过长')
        with self.connect() as db:
            rs=[self.get(db,'records',id) for id in ids]
            if any(r['status'] not in ('overseas','domestic') for r in rs): raise ValidationError('其中有专辑不能出售，请刷新列表')
            gs=allocate(gross,[1]*len(rs));fs=allocate(fees,[1]*len(rs));ps=allocate(postage,[1]*len(rs))
            s={'id':uid(),'date':day(data.get('date'),'售出日期'),'status':'shipping','receivedDate':'',
                'gross':money(gross),'fees':money(fees),'postage':money(postage),'address':address,
                'note':str(data.get('note','')),'channel':str(data.get('channel','闲鱼')),'orderId':str(data.get('orderId','')),
                'createdAt':now(),
                'items':[{'recordId':r['id'],'gross':g,'fees':f,'postage':p,'refund':'0.00'} for r,g,f,p in zip(rs,gs,fs,ps)]}
            for r in rs:
                r['previousStatus']=r['status'];r['status']='shipping';r['saleId']=s['id'];r['revision']+=1;self.put(db,'records',r)
            self.put(db,'sales',s);self.audit(db,'记录售出',s)
        return {'id':s['id']}
    def sale_action(self,data):
        self.require_module('trading')
        with self.connect() as db:
            s=self.get(db,'sales',data.get('id'));old=json.loads(dumps(s));action=data.get('action')
            if s['status']=='complete': raise ValidationError('已确认收货，钱款已成现金，交易不可再改动')
            if s['status'] not in ('shipping',): raise ValidationError('这笔交易已处理，不能重复操作')
            if action=='receive':
                s['status']='complete';s['receivedDate']=day(data.get('date'),'到账日期')
                for item in s['items']:
                    r=self.get(db,'records',item['recordId']);r['status']='sold';r['revision']+=1;self.put(db,'records',r)
            elif action=='cancel':
                s['status']='cancelled'
                for item in s['items']:
                    r=self.get(db,'records',item['recordId']);r['status']=r.get('previousStatus') if r.get('previousStatus') in ('overseas','domestic') else 'domestic';r.pop('saleId',None);r['revision']+=1;self.put(db,'records',r)
            elif action=='refund':
                refund=number(data.get('refund'),'退款总额')
                if refund>Decimal(s['gross']): raise ValidationError('退款不能超过买家支付总额')
                shares=allocate(refund,[Decimal(i['gross']) for i in s['items']])
                returned=data.get('returned') is True
                s['status']='returned' if returned else 'refunded';s['refundDate']=day(data.get('date'),'退款日期')
                for item,share in zip(s['items'],shares):
                    item['refund']=share
                    if returned:
                        r=self.get(db,'records',item['recordId']);r['status']='domestic';r.pop('saleId',None);r['revision']+=1;self.put(db,'records',r)
            else: raise ValidationError('不支持的操作')
            self.put(db,'sales',s);self.audit(db,'销售 '+action,{'before':old,'after':s})
        return {'ok':True}
    def restore_backup(self,b):
        if not isinstance(b,dict) or b.get('format')!='album-ledger': raise ValidationError('不是兼容的完整备份文件')
        if not isinstance(b.get('records'),list) or not isinstance(b.get('sales'),list): raise ValidationError('备份内容不完整')
        if not isinstance(b.get('settings', {}), dict): raise ValidationError('备份的设置无效')
        if 'modules-v1' in b.get('settings', {}): clean_modules(b['settings']['modules-v1'])
        # Old (schema-1/2) backups are upgraded on the fly so they stay restorable.
        for r in b['records']:
            if r.get('status')=='review': r['status']='domestic'
            if r.get('previousStatus')=='review': r['previousStatus']='domestic'
            for k in ('rate','rateSource'): r.pop(k,None)
        for s in b['sales']:
            if s.get('status')=='pending':
                s['status']='complete';s['date']=s.get('receivedDate') or s.get('date')
            s.setdefault('postage','0.00');s.setdefault('address','');s.setdefault('orderId','')
        shipments=b.get('shipments')
        if shipments is None: shipments=[]
        if not isinstance(shipments,list): raise ValidationError('备份的运输数据无效')
        ids=set()
        for r in b['records']:
            normalized=clean_record(r)
            if any(normalized.get(k)!=r.get(k) for k in ('title','artist','date','price','currency','fees','actual','cover')):
                raise ValidationError('备份中的专辑字段不完整或格式不正确')
            if not isinstance(r.get('revision'),int) or r['revision']<1: raise ValidationError('备份缺少记录版本')
            if not r.get('id') or r['id'] in ids or r.get('status') not in STATUSES: raise ValidationError('备份记录无效')
            ids.add(r['id'])
        shipment_ids=set()
        for sh in shipments:
            if sh.get('id') in shipment_ids or sh.get('status') not in SHIPMENT_STATUSES: raise ValidationError('备份的运输状态或 ID 无效')
            shipment_ids.add(sh['id'])
            day(sh.get('date'),'发货日期')
            number(sh.get('cost',0),'运费')
            if not sh.get('items') or any(i.get('recordId') not in ids for i in sh['items']): raise ValidationError('备份的运输关联不完整')
        sale_ids=set()
        for s in b['sales']:
            if s.get('id') in sale_ids or s.get('status') not in SALE_STATUSES: raise ValidationError('备份的销售状态或 ID 无效')
            sale_ids.add(s.get('id'))
            day(s.get('date'),'销售日期')
            number(s.get('gross'),'销售总额');number(s.get('fees'),'销售费用')
            if not s.get('id') or not s.get('items') or any(i.get('recordId') not in ids for i in s['items']): raise ValidationError('备份的销售关联不完整')
            for i in s['items']:
                for k in ('gross','fees','refund'): number(i.get(k,0),k)
        for r in b['records']:
            if r['status'] in ('sold','shipping'):
                want='complete' if r['status']=='sold' else 'shipping'
                matches=[s for s in b['sales'] if s['id']==r.get('saleId') and s['status'] in (want,'refunded') and any(i['recordId']==r['id'] for i in s['items'])]
                if len(matches)!=1: raise ValidationError('备份中的售出记录缺少有效销售单')
        self.checkpoint()
        with self.connect() as db:
            for table in ('records','sales','shipments','audit','meta'): db.execute(f'DELETE FROM {table}')
            for r in b['records']: self.put(db,'records',r)
            for s in b['sales']: self.put(db,'sales',s)
            for sh in shipments: self.put(db,'shipments',sh)
            for a in b.get('audit',[]): db.execute('INSERT INTO audit(at,action,data) VALUES(?,?,?)',(a['at'],a['action'],a['data']))
            for k,v in b.get('settings',{}).items():
                if k!='schema': db.execute('INSERT INTO meta VALUES(?,?)',(k,dumps(v)))
            db.execute("INSERT OR REPLACE INTO meta VALUES('schema',?)",(dumps(SCHEMA),))
            self.audit(db,'恢复完整备份',{'from':b.get('createdAt')})
        return {'ok':True}

    # ── RYM 艺人直达链接：绑定一次（书签从 RYM 艺人页回传），此后点击直达 ──
    def meta_get(self, db, key):
        row = db.execute('SELECT data FROM meta WHERE key=?',(key,)).fetchone()
        return json.loads(row['data']) if row else None

    def rym_token(self):
        """书签回传绑定的凭据；首次访问时生成，随备份走。"""
        with self.connect() as db:
            token = self.meta_get(db, 'rym-token')
            if token: return token
            token = secrets.token_hex(16)
            db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',('rym-token',dumps(token)))
            return token

    def artist_links(self):
        with self.connect() as db:
            return self.meta_get(db, 'rym-links') or {}

    def bind_artist(self, token, title, url):
        """凭书签令牌把一个 RYM 艺人页绑定到库内同名艺人；认不出艺人则不绑定。"""
        with self.connect() as db:
            if not isinstance(token, str) or token != self.meta_get(db, 'rym-token'):
                raise ValidationError('绑定凭据不正确，请到设置页重新复制书签')
            link = rym_artist_url(url)
            if not link: raise ValidationError('这不是 RateYourMusic 的艺人页链接')
            t = normalized(str(title))
            if not t: raise ValidationError('未能读取艺人页标题')
            links = self.meta_get(db, 'rym-links') or {}
            pending = sorted({r['artist'] for r in self.rows(db,'records') if r.get('artist')} - set(links))
            hits = []
            for a in pending:
                for v in artist_variants(a):
                    nv = normalized(v)
                    if not nv: continue
                    if nv == t: hits.append((3, a)); break
                    if len(nv) >= 2 and t.startswith(nv): hits.append((2, a)); break
                    if len(nv) >= 4 and nv in t: hits.append((1, a)); break
            artist = None
            if hits:
                best = max(s for s, _ in hits)
                names = {a for s, a in hits if s == best}
                if len(names) == 1:
                    artist = names.pop()
                    links[artist] = link
                    db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',('rym-links',dumps(links)))
                    self.audit(db,'绑定RYM艺人',{'artist':artist,'url':link})
            return {'ok':True,'artist':artist,'bound':len(links)}
