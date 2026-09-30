import sys,json,urllib.request,re,html
from pathlib import Path
from urllib.parse import urljoin
from html.parser import HTMLParser
class Parser(HTMLParser):
 def __init__(self):super().__init__();self.images=[];self.og=None
 def handle_starttag(self,tag,attrs):
  a=dict(attrs)
  if tag=='img':self.images.append(a)
  if tag=='meta' and a.get('property')=='og:image':self.og=a.get('content')
out=Path('data/cover-audit/sources');out.mkdir(exist_ok=True)
for i,url in enumerate(sys.argv[1:]):
 try:
  raw=urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=20).read();text=raw.decode('utf-8','replace');p=Parser();p.feed(text)
  name=url.split('/')[2].replace('.','_')+'-'+str(i);(out/(name+'.html')).write_bytes(raw)
  for img in p.images:
   src=img.get('src','');idx=text.find(src);img['context']=re.sub('<[^>]+>',' ',text[max(0,idx-100):idx+350]);img['src']=urljoin(url,src)
  print(json.dumps({'url':url,'file':name,'og':p.og,'images':p.images},ensure_ascii=False),flush=True)
 except Exception as e:print(url,repr(e),flush=True)
