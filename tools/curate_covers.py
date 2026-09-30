import json,pathlib,urllib.request,base64,sys,time
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parents[1]))
from storage import Store
root=pathlib.Path('data/cover-audit');out=root/'final';out.mkdir(exist_ok=True)
ids={'Standing on the Shoulder of Giants':1517445612,'The Dark Side of the Moon':1065973699,'Animals':1065974284,'The Division Bell':1065976549,'21世紀のブレイクダウン':1156538220,'Dookie':1160081985,'American Idot':1161539183,'Save Rock and Roll':1440862257,'True':1440872730,'Avīci (01)':1440899018,'Live!':1452877497,'Ghost in the Machine':1440754948,'Carrie & Lowell':955572616,'The Age of Adz':392327958,'Michigan':327920307,'Red':918614446,"Larks' Tongues in Aspic":918568338,'Frengers':1308760509,'ハチミツ':1440745865,'ひみつスタジオ':1683240533,'盗作':1519740112,'今夜このまま':1438144187,'REQUEST':1584649558}
overrides={"Minecraft: Volume Alpha":"minecraft", "Hurry Up, We're Dreaming.":"m83","It's a Poppin' Time":'poppin','FOR YOU':'foryou','MELODIES':'melodies','Treasures':'treasures','キセキ':'kiseki','物語シリーズ:歌物語':'utamonogatari','「坂の上の雲」サウンドトラック':'sakano','「ゆるキャン△」オリジナル・サンドドラック':'yuru','もしも生まれ変わったならそっとこんな声になって':'tribute','Schizoid Man':'schizoid','伝説から神話へ 日本武道館さよ':'momoe2009','The Wall Rehearsals 1980':'wall'}
catalog={a['collectionId']:a for p in (root/'catalogs').glob('*.json') for a in json.loads(p.read_text())['albums'] if 'collectionId' in a}
rows=Store(pathlib.Path('data/albums.sqlite3')).backup()['records'];manifest=[]
for n,r in enumerate(rows):
 d=json.loads((root/(r['id']+'.json')).read_text());title=r['title'];note='专辑名与艺人核对；封面采用对应发行目录图，未确认所有实体再版差异。'
 if title in overrides:
  result=json.loads((root/'overrides'/(overrides[title]+'.json')).read_text())['image']
  note=result['coverSource'].get('note',note)
 elif title in ids:
  a=catalog[ids[title]];url=a['artworkUrl100'].replace('100x100bb','600x600bb');cache=out/(str(ids[title])+'.jpg')
  if not cache.exists():cache.write_bytes(urllib.request.urlopen(url,timeout=30).read())
  result={'cover':'data:image/jpeg;base64,'+base64.b64encode(cache.read_bytes()).decode(),'coverSource':{'provider':'iTunes artist catalog','title':a['collectionName'],'artist':a['artistName'],'url':url,'page':a['collectionViewUrl']}}
 else:
  result=d.get('imageUS') or d.get('image')
  if not result:raise RuntimeError(title)
 if title=='伝説から神話へ 日本武道館さよ':note='用户允许暂选：2009 年 DVD MHBL-117；实体版次未确认。'
 if title=='The Wall Rehearsals 1980':note='采用 2025 年同名商品目录实物图；具体厂牌版次未确认。'
 result['coverSource']['verificationNote']=note
 entry={'number':n+1,'id':r['id'],'title':title,'artist':r['artist'],**result}
 (out/(r['id']+'.json')).write_text(json.dumps(entry,ensure_ascii=False))
 (out/(r['id']+'.jpg')).write_bytes(base64.b64decode(result['cover'].split(',')[1]));manifest.append({k:v for k,v in entry.items() if k!='cover'})
 print(n+1,title,flush=True)
(root/'verified-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2))
