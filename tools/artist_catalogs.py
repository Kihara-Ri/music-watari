import json,time,urllib.request
from pathlib import Path
from urllib.parse import urlencode
artists=['Green Day','Pink Floyd','Oasis','Fall Out Boy','The Police','Sufjan Stevens','Avicii','スピッツ','ヨルシカ','あいみょん','竹内まりや','Mew','King Crimson']
out=Path('data/cover-audit/catalogs');out.mkdir(exist_ok=True)
for artist in artists:
 p=out/(artist.replace('/','_')+'.json')
 if p.exists():continue
 try:
  country='US' if artist.isascii() else 'JP'
  result=json.load(urllib.request.urlopen('https://itunes.apple.com/search?'+urlencode({'term':artist,'entity':'musicArtist','limit':5,'country':country}),timeout=15));match=result['results'][0];time.sleep(3.4)
  albums=json.load(urllib.request.urlopen('https://itunes.apple.com/lookup?'+urlencode({'id':match['artistId'],'entity':'album','limit':200,'country':country}),timeout=15))
  p.write_text(json.dumps({'artist':artist,'match':match,'albums':albums['results']},ensure_ascii=False,indent=2));print(artist,match['artistName'],len(albums['results']),flush=True)
 except Exception as e:print(artist,repr(e),flush=True)
 time.sleep(3.4)
