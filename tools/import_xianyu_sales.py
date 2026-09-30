#!/usr/bin/env python3
"""One-off import: 12 Xianyu sales from screenshots in data/售出的CD交易记录/.

- migrates schema 2 statuses (review → domestic)
- marks 7 matched library records sold (user-confirmed picks for the two duplicates)
- creates 5 never-imported albums as sold records with unknown cost (待补)
- fetches covers for the new records via the cover service (exact matches only)
- warms the JPY rate cache for every buy date
Run:  python3 tools/import_xianyu_sales.py [--dry-run]
"""
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from storage import Store
from covers import CoverService
from rates import RateService

ROOT = Path(__file__).resolve().parent.parent

# date = 闲鱼成交时间（钱款到账）; gross = 成交价; net = 预估到手; fees = gross - net (含运费抵扣)
# 当 到手 > 标价（买家另付运费）时以到手金额为 gross、fees 记 0，保证净收入与到账现金一致。
SALES = [
    # (match: title-contains, buy-date, artist) or None → create new record
    dict(match=('Remain in Light','2026-02-28'), title='Remain in Light', artist='Talking Heads',
         gross='78.00', net='72.45', date='2026-09-27', order='5127719472148021542'),
    dict(match=None, title='Pet Sounds', artist='The Beach Boys',
         gross='78.00', net='76.36', date='2026-09-27', order='5127716556160021542'),
    dict(match=None, title='For the first time', artist='Black Country, New Road',
         gross='118.00', net='115.52', date='2026-09-25', order='5127448466135025643'),
    dict(match=('Illinois','2026-02-18'), title='Illinois', artist='Sufjan Stevens',
         gross='126.00', net='125.24', date='2026-09-25', order='3316440614042021568'),
    dict(match=('The Glow Pt. 2','2026-03-07'), title='The Glow Pt. 2', artist='The Microphones',
         gross='128.00', net='125.31', date='2026-09-20', order='5127336344461021487'),
    dict(match=('もしも生まれ変わったなら','2026-02-28'), title='もしも生まれ変わったならそっとこんな声になって', artist='V.A.',
         gross='110.00', net='97.90', date='2026-09-01', order='5127217311093084137'),
    dict(match=('Red','2026-02-02'), title='Red', artist='King Crimson',
         gross='110.00', net='107.69', date='2026-08-21', order='3316977084182003063'),
    dict(match=('Ants From Up There','2026-02-18'), title='Ants From Up There', artist='Black Country, New Road',
         gross='120.00', net='117.48', date='2026-08-10', order='3315755786812008073'),
    dict(match=None, title='Funeral', artist='Arcade Fire',
         gross='85.00', net='78.32', date='2026-08-11', order='5127089142444021512'),
    dict(match=None, title='Javelin', artist='Sufjan Stevens',
         gross='158.00', net='154.68', date='2026-08-06', order='5127055569665021931'),
    dict(match=('KID A MNESIA','2026-01-22'), title='KID A MNESIA', artist='Radiohead',
         gross='170.00', net='156.64', date='2026-08-09', order='5127341688316244110'),
    dict(match=None, title='In Rainbows', artist='Radiohead',
         gross='122.37', net='122.37', date='2026-07-26', order='5125465513077022633'),
]

def fees_for(s):
    from decimal import Decimal
    diff = Decimal(s['gross']) - Decimal(s['net'])
    return str(max(diff, Decimal('0')))

def main():
    dry = '--dry-run' in sys.argv
    covers = CoverService(ROOT/'data/cover-cache.sqlite3')
    rates = RateService(ROOT/'data/rates.sqlite3')
    store = Store(ROOT/'data/albums.sqlite3', rates)
    with store.connect() as db:
        records = store.rows(db,'records')
        existing_orders = {s.get('orderId') for s in store.rows(db,'sales')}
    todo = [s for s in SALES if s['order'] not in existing_orders]
    if not todo:
        print('所有 12 笔销售已存在，跳过销售导入；继续处理封面与汇率。')
        todo = []
    plan = []
    for s in todo:
        rid = None
        if s['match']:
            frag, buy_date = s['match']
            hits = [r for r in records if frag.lower() in r['title'].lower() and r.get('date')==buy_date and r['status'] in ('overseas','domestic')]
            if not hits:
                hits = [r for r in records if frag.lower() in r['title'].lower() and r.get('date')==buy_date]
            if len(hits) != 1:
                print(f"!! 匹配失败：{s['title']} ({frag}, {buy_date}) -> {len(hits)} 条"); return
            rid = hits[0]['id']; how = f"库内 {hits[0]['id'][:8]}（{hits[0]['date']} 买入 {hits[0]['price']} {hits[0]['currency']}）"
        else:
            how = '新建记录（买入价待补）'
        plan.append((s, rid, how))
        print(f"{s['date']}  {s['title']} / {s['artist']}: 售 {s['gross']} 到手 {s['net']}  -> {how}")
    if dry:
        print('--dry-run：未写入。'); return

    store.checkpoint()
    created = {}
    with store.connect() as db:
        by_order = {}
        for s in store.rows(db,'sales'):
            oid = s.get('orderId','')
            if oid and oid not in by_order and s['items']:
                by_order[oid] = s['items'][0]['recordId']
    for s, rid, how in plan:
        if rid is None:
            rid = store.save({'title':s['title'],'artist':s['artist'],'date':'','price':'','currency':'JPY',
                'location':'','note':'买入信息待补：2026-09-28 由闲鱼售出记录补录','fees':'0'})['ids'][0]
            created[s['order']] = rid
        store.sell({'ids':[rid],'gross':s['gross'],'fees':fees_for(s),'date':s['date'],
            'channel':'闲鱼','orderId':s['order'],'note':f"订单 {s['order']}（截图补录）"})
        print(f"已导入：{s['title']} ← {s['order']}")

    # covers for records still missing one (the never-imported five in particular)
    for s in SALES:
        rid = created.get(s['order']) or by_order.get(s['order'])
        if rid is None: continue
        with store.connect() as db:
            rec = store.get(db,'records',rid)
        if rec.get('cover'): continue
        try:
            found = covers.search(s['title'], s['artist'], 'AUTO')
            exact = [c for c in found['candidates'] if c['exact']]
            if len(exact)==1:
                img = covers.download(exact[0]['token'])
                with store.connect() as db:
                    cur = store.get(db,'records',rid)
                store.save({**cur, **img})
                print(f"封面已匹配：{s['title']}（{img['coverSource']['provider']}）")
            else:
                print(f"封面待手动选择：{s['title']}（{len(found['candidates'])} 个候选）")
        except Exception as e:
            print(f"封面获取失败：{s['title']}：{e}")

    # warm rates for every buy date
    with store.connect() as db:
        days = [r.get('date') for r in store.rows(db,'records') if r.get('date')]
    rates.warm(sorted(set(days)))
    st = rates.status()
    print(f"汇率缓存：{st['days']} 天，最新 {st['latest']}")
    state = store.state()
    from collections import Counter
    print('状态分布：', dict(Counter(r['status'] for r in state['records'])))
    print('销售笔数：', len(state['sales']))

if __name__=='__main__':
    main()
