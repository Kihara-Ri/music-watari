"""End-to-end HTTPS verification without printing credentials or collection data."""
from pathlib import Path
import json,urllib.request,http.cookiejar,ssl
root=Path(__file__).resolve().parents[1]
base='https://albums.kihara.cn'
jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def request(path,data=None):
 req=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),headers={} if data is None else {'Content-Type':'application/json','Origin':base})
 try:
  with opener.open(req,timeout=30) as r:return r.status,r.headers,r.read()
 except urllib.error.HTTPError as e:return e.code,e.headers,e.read()
status,_,_=request('/api/state');assert status==401,status
password=(root/'部署登录信息.txt').read_text().splitlines()[1]
status,headers,_=request('/api/login',{'password':password});assert status==200,status
assert 'Secure' in headers.get('Set-Cookie','') and 'HttpOnly' in headers.get('Set-Cookie','')
status,_,data=request('/api/state');assert status==200
state=json.loads(data);assert len(state['records'])==89
assert sum(bool(r.get('cover')) for r in state['records'])==89
status,_,data=request('/api/backup');assert status==200 and len(json.loads(data)['records'])==89
status,_,data=request('/manifest.webmanifest');assert status==200 and json.loads(data)['display']=='standalone'
status,_,_=request('/api/logout',{});assert status==200
status,_,_=request('/api/backup');assert status==401
print('HTTPS valid; login, 89 records/89 covers, backup download, PWA manifest, logout protection passed')
