import sys,urllib.request,json,base64,io
from pathlib import Path
from PIL import Image
name,url,page,*extra=sys.argv[1:]
out=Path('data/cover-audit/overrides');out.mkdir(exist_ok=True)
raw=urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=25).read()
im=Image.open(io.BytesIO(raw));im.load();im=im.convert('RGB');im.thumbnail((1000,1000));b=io.BytesIO();im.save(b,format='JPEG',quality=92);data=b.getvalue()
(out/(name+'.jpg')).write_bytes(data)
(out/(name+'.json')).write_text(json.dumps({'image':{'cover':'data:image/jpeg;base64,'+base64.b64encode(data).decode(),'coverSource':{'provider':'verified-catalog','url':url,'page':page,'note':' '.join(extra)}},'dimensions':im.size},ensure_ascii=False,indent=2))
print(name,im.size,len(data))
