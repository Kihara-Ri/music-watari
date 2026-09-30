import sys,json,time,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from covers import CoverService,similarity
from storage import Store
root=Path(__file__).resolve().parents[1];out=root/'data/cover-audit';service=CoverService()
rows=Store(root/'data/albums.sqlite3').backup()['records']
for r in rows:
 p=out/(r['id']+'.json');d=json.loads(p.read_text())
 if d.get('us') or (d.get('selected') or {}).get('exact') or not r['artist'].isascii():continue
 if r['artist'] in ['GReeeeN','supercell','Vareity Artists']:continue
 title,artist=d['query'];q=out/(r['id']+'-us.jpg')
 try:
  result=service.search(title,artist,'US');d['us']=result
  for c in result['candidates']:
   if similarity(c['artist'],artist)>.94 and c['score']>.65:
    image=service.download(c['token']);d['selectedUS']=c;d['imageUS']=image;q.write_bytes(base64.b64decode(image['cover'].split(',')[1]));break
  print(r['title'],'=>',[(c['title'],c['artist'],c['score']) for c in result['candidates'][:2]],flush=True)
 except Exception as e:d['usError']=str(e);print(r['title'],'ERROR',str(e),flush=True)
 p.write_text(json.dumps(d,ensure_ascii=False,indent=2));time.sleep(3.4)
