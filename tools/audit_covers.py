import sys,json,time,base64
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from covers import CoverService
from storage import Store
root=Path(__file__).resolve().parents[1];out=root/'data/cover-audit';out.mkdir(exist_ok=True)
rows=Store(root/'data/albums.sqlite3').backup()['records'];service=CoverService()
for idx,r in enumerate(rows):
 p=out/(r['id']+'.json')
 if p.exists():continue
 title=r['title'];artist=r['artist']
 aliases={'チェンソーマン:KICK BACK':('KICK BACK','米津玄師'),'American Idot':('American Idiot','Green Day'),'21世紀のブレイクダウン':('21st Century Breakdown','Green Day'),'物語シリーズ:歌物語':('歌物語','Various Artists'),'「ゆるキャン△」オリジナル・サンドドラック':('ゆるキャン オリジナル サウンドトラック','立山秋航'),'もしも生まれ変わったならそっとこんな声になって':('もしも生まれ変わったならそっとこんな声になって','Various Artists'),'伝説から神話へ 日本武道館さよ':('伝説から神話へ 日本武道館さよならコンサート','山口百恵')}
 title,artist=aliases.get(title,(title,artist))
 if artist=='M83.':artist='M83'
 result={'recordId':r['id'],'title':r['title'],'artist':r['artist'],'query':[title,artist],'candidates':[]}
 try:
  result.update(service.search(title,artist));candidates=result['candidates']
  if candidates and candidates[0]['score']>=.63:
   best=candidates[0];image=service.download(best['token']);result['selected']=best;result['image']=image
   (out/(r['id']+'.jpg')).write_bytes(base64.b64decode(image['cover'].split(',')[1]))
  print(idx+1,r['title'],'=>',[(c['title'],c['artist'],c['score']) for c in candidates[:2]],flush=True)
 except Exception as e:result['error']=str(e);print(idx+1,'ERROR',str(e),flush=True)
 p.write_text(json.dumps(result,ensure_ascii=False,indent=2));time.sleep(3.3)
