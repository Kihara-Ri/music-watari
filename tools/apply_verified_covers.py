"""Apply the explicitly reviewed manifest, keeping all non-artwork data intact."""
import sys,json,base64,io
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from PIL import Image
from storage import Store
root=Path('data/cover-audit');manifest=json.loads((root/'verified-manifest.json').read_text());store=Store('data/albums.sqlite3')
assert len(manifest)==89
entries=[json.loads((root/'final'/(m['id']+'.json')).read_text()) for m in manifest]
for e in entries:
 im=Image.open(io.BytesIO(base64.b64decode(e['cover'].split(',')[1])));im.load();assert min(im.size)>=200
store.checkpoint()
with store.connect() as db:
 db.execute('BEGIN IMMEDIATE');before=store.rows(db,'records')
 for e in entries:
  old=store.get(db,'records',e['id']);assert old['title']==e['title'] and old['artist']==e['artist']
  r={**old,'cover':e['cover'],'coverSource':e['coverSource'],'revision':old['revision']+1}
  store.put(db,'records',r);store.audit(db,'核对并补齐封面',{'id':r['id'],'before':old})
 after=store.rows(db,'records')
 strip=lambda r:{k:v for k,v in r.items() if k not in ('cover','coverSource','revision')}
 assert [strip(r) for r in before]==[strip(r) for r in after]
 assert sum(bool(r.get('cover')) for r in after)==89
report=['# 专辑封面核对报告','','89 / 89 条记录已保存可解码的封面；购买数据、汇率、原始备注和库存状态保持不变。保存前已生成完整备份。','','逐张进行了图像检查；核对专辑与艺人，不代表全部实体再版、地区版的包装差异均已确认。山口百惠按用户允许暂用 2009 年 DVD；The Wall Rehearsals 1980 使用 2025 年同名商品实物图，具体厂牌版次未确认。','','| 序号 | 专辑 | 艺人 | 来源 | 说明 |','|---|---|---|---|---|']
for m in manifest:
 s=m['coverSource'];url=s.get('page') or s.get('url');report.append(f"| {m['number']} | {m['title']} | {m['artist']} | [来源]({url}) | {s.get('verificationNote','')} |")
Path('封面核对报告.md').write_text('\n'.join(report))
print('89 images decoded, saved transactionally, original fields unchanged')
