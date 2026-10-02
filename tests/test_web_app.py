import unittest,tempfile,threading,json,hashlib,http.client,sqlite3,gzip,base64
from pathlib import Path
from http.server import ThreadingHTTPServer
from backups import Backups
from covers import CoverService
from rates import RateService
from security import Auth
from server import Services,make_handler
from storage import Store

class WebTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);self.store=Store(self.root/'albums.sqlite3');self.auth=Auth(self.root/'auth.sqlite3');self.auth.set_password('test-password-12345');self.backups=Backups(self.store.path)
  services=Services(store=self.store,auth=self.auth,backups=self.backups,covers=CoverService(self.root/'covers.sqlite3'),rates=RateService(self.root/'rates.sqlite3'),public_origin='https://albums.example.test')
  self.server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(services));threading.Thread(target=self.server.serve_forever,daemon=True).start()
 def tearDown(self):self.server.shutdown();self.server.server_close();self.tmp.cleanup()
 def req(self,path,body=None,cookie=None,origin=None,host=None,**extra):
  c=http.client.HTTPConnection('127.0.0.1',self.server.server_port);headers={}
  if cookie:headers['Cookie']=cookie
  if origin:headers['Origin']=origin
  if host:headers['Host']=host
  if extra:headers.update(extra)
  if body is not None:headers['Content-Type']='application/json'
  c.request('GET' if body is None else 'POST',path,None if body is None else json.dumps(body),headers);r=c.getresponse();out=(r.status,dict(r.getheaders()),r.read());c.close();return out
 def test_protected_data_and_session(self):
  for p in ['/api/state','/api/backup','/api/export']:self.assertEqual(self.req(p)[0],401)
  status,h,_=self.req('/api/login',{'password':'test-password-12345'});self.assertEqual(status,200);cookie=h['Set-Cookie'];self.assertIn('HttpOnly',cookie);self.assertIn('Secure',cookie)
  self.assertEqual(self.req('/api/state',cookie=cookie)[0],200)
  self.assertEqual(self.req('/api/logout',{},cookie=cookie)[0],200)
  self.assertEqual(self.req('/api/state',cookie=cookie)[0],401)
 def test_module_settings_api_and_disabled_operation(self):
  flags={'acquisition':False,'trading':False,'circulation':False}
  self.assertEqual(self.req('/api/modules',{'enabled':flags})[0],401)
  _,h,_=self.req('/api/login',{'password':'test-password-12345'});cookie=h['Set-Cookie']
  self.assertEqual(self.req('/api/modules',{'enabled':flags},cookie=cookie,origin='https://evil.test')[0],403)
  self.assertEqual(self.req('/api/modules',{'enabled':flags},cookie=cookie)[0],200)
  status,_,body=self.req('/api/state',cookie=cookie);self.assertEqual(status,200)
  self.assertEqual(json.loads(body)['modules']['enabled'],flags)
  _,_,body=self.req('/api/records',{'title':'收藏','artist':'艺人'},cookie=cookie)
  rid=json.loads(body)['ids'][0]
  self.assertEqual(self.req('/api/bulk',{'ids':[rid],'action':'list'},cookie=cookie)[0],400)
  self.assertEqual(self.req('/api/modules',{'enabled':{**flags,'circulation':True}},cookie=cookie)[0],400)
 def test_origins_and_hosts(self):
  self.assertEqual(self.req('/api/login',{'password':'test-password-12345'},origin='https://evil.test')[0],403)
  self.assertEqual(self.req('/',host='evil.test')[0],403)
  # Host 正确但未登录：页面不返回应用本体，服务端 302 到登录页
  status,h,_=self.req('/',host='albums.example.test')
  self.assertEqual(status,302);self.assertEqual(h['Location'],'/login')
 def test_loopback_port_remap_trusted(self):
  # Docker 端口映射：回环主机 + 任意端口可信；Origin 须与 Host 一致（挡 localhost 旁站 CSRF）
  status,h,_=self.req('/',host='127.0.0.1:18765')
  self.assertEqual(status,302);self.assertEqual(h['Location'],'/login')
  self.assertEqual(self.req('/api/login',{'password':'test-password-12345'},host='127.0.0.1:18765',origin='http://127.0.0.1:18765')[0],200)
  self.assertEqual(self.req('/api/login',{'password':'test-password-12345'},host='127.0.0.1:18765',origin='http://localhost:3000')[0],403)
 def test_artist_bind_cross_site_token(self):
  status,h,_=self.req('/api/login',{'password':'test-password-12345'});cookie=h['Set-Cookie']
  self.assertEqual(self.req('/api/records',{'title':'测试专辑','artist':'米津玄師','date':'2026-09-07','price':'2000','currency':'JPY','fees':'0'},cookie=cookie)[0],200)
  status,_,body=self.req('/api/artist-links',cookie=cookie);self.assertEqual(status,200)
  token=json.loads(body)['token']
  self.assertEqual(self.req('/api/artist-links')[0],401)
  # 书签的跨站 no-cors 形态：text/plain + 外站 Origin + Sec-Fetch-Site，凭令牌放行
  c=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
  payload=json.dumps({'token':token,'title':'米津玄師 Albums: songs, discography','url':'https://rateyourmusic.com/artist/kenshi_yonezu'})
  c.request('POST','/api/artist-bind',payload,{'Content-Type':'text/plain','Origin':'https://rateyourmusic.com','Sec-Fetch-Site':'cross-site'})
  r=c.getresponse();out=json.loads(r.read());c.close()
  self.assertEqual(out['artist'],'米津玄師')
  c=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
  c.request('POST','/api/artist-bind',json.dumps({'token':'bad','title':'米津玄師','url':'https://rateyourmusic.com/artist/kenshi_yonezu'}),{'Content-Type':'text/plain'})
  self.assertEqual(c.getresponse().status,400);c.close()
 def test_throttle_and_expiry(self):
  for i in range(5):
   with self.assertRaises(ValueError):self.auth.login('wrong','ip')
  with self.assertRaisesRegex(ValueError,'15 分钟'):self.auth.login('test-password-12345','ip')
  token=self.auth.login('test-password-12345','other');self.assertTrue(self.auth.valid('album_session='+token))
  with sqlite3.connect(self.auth.path) as db:db.execute('UPDATE sessions SET expires=0')
  self.assertFalse(self.auth.valid('album_session='+token))
 def test_change_password_kicks_other_sessions(self):
  self.assertEqual(self.req('/api/password',{'current':'x','next':'y'})[0],401)
  _,h,_=self.req('/api/login',{'password':'test-password-12345'});cookie_a=h['Set-Cookie']
  _,h,_=self.req('/api/login',{'password':'test-password-12345'});cookie_b=h['Set-Cookie']
  status,_,body=self.req('/api/password',{'current':'wrong-current-000','next':'brand-new-password-1'},cookie=cookie_a)
  self.assertEqual(status,400);self.assertIn('当前密码不正确',json.loads(body)['error'])
  status,_,body=self.req('/api/password',{'current':'test-password-12345','next':'short'},cookie=cookie_a)
  self.assertEqual(status,400)
  # 成功改密：会话 B 失效、会话 A 保留；旧密码不能再登录
  self.assertEqual(self.req('/api/password',{'current':'test-password-12345','next':'brand-new-password-1'},cookie=cookie_a)[0],200)
  self.assertEqual(self.req('/api/state',cookie=cookie_b)[0],401)
  self.assertEqual(self.req('/api/state',cookie=cookie_a)[0],200)
  self.assertEqual(self.req('/api/login',{'password':'test-password-12345'})[0],400)
  status,h,_=self.req('/api/login',{'password':'brand-new-password-1'});self.assertEqual(status,200)
 def test_session_sliding_renewal(self):
  # 剩余不足 15 天时 valid() 顺延回 30 天：持续使用不掉线；剩余充足时不改写
  import time
  token=self.auth.login('test-password-12345','sliding');h=hashlib.sha256(token.encode()).hexdigest()
  with sqlite3.connect(self.auth.path) as db:db.execute('UPDATE sessions SET expires=? WHERE token=?',(time.time()+5*86400,h))
  self.assertTrue(self.auth.valid('album_session='+token))
  with sqlite3.connect(self.auth.path) as db:
   expires=db.execute('SELECT expires FROM sessions WHERE token=?',(h,)).fetchone()[0]
  self.assertGreater(expires,time.time()+29*86400)
  with sqlite3.connect(self.auth.path) as db:db.execute('UPDATE sessions SET expires=? WHERE token=?',(time.time()+20*86400,h))
  self.assertTrue(self.auth.valid('album_session='+token))
  with sqlite3.connect(self.auth.path) as db:
   expires=db.execute('SELECT expires FROM sessions WHERE token=?',(h,)).fetchone()[0]
  self.assertAlmostEqual(expires,time.time()+20*86400,delta=5)
 def test_backup_restore_integrity_and_retention(self):
  for i in range(1,10):(self.backups.folder/f'2000-01-{i:02}.sqlite3').touch()
  self.backups.run();self.assertEqual(self.backups.status()['count'],7)
  p=sorted(self.backups.folder.glob('*.sqlite3'))[-1]
  with sqlite3.connect(p) as db:self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok');self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='records'").fetchone())
  stamp=p.stat().st_mtime;self.backups.run();self.assertEqual(stamp,p.stat().st_mtime)
 def test_health_public_and_versioned(self):
  status,_,body=self.req('/api/health');self.assertEqual(status,200)
  d=json.loads(body);self.assertTrue(d['ok']);self.assertIn('version',d);self.assertEqual(d['schema'],4)
 def test_pwa_assets_and_login_gate(self):
  status,_,body=self.req('/manifest.webmanifest');self.assertEqual(status,200);self.assertEqual(json.loads(body)['display'],'standalone')
  # 未登录：登录页自身、其渲染依赖与 PWA 壳元数据可取；其余一切路径 302 到登录页
  for p in ['/login','/login.js','/theme.js','/assets/index.css','/favicon.svg','/sw.js','/offline.html','/icon-192.png','/icon-512.png']:self.assertEqual(self.req(p)[0],200,p)
  for p in ['/','/index.html','/assets/index.js','/vendor/heic2any.min.js','/data/albums.sqlite3','/no-such-file']:
   status,h,_=self.req(p);self.assertEqual(status,302,p);self.assertEqual(h['Location'],'/login',p)
  # 登录后：应用本体与 vendor 可访问
  status,h,_=self.req('/api/login',{'password':'test-password-12345'});cookie=h['Set-Cookie']
  for p in ['/','/assets/index.js','/vendor/heic2any.min.js']:self.assertEqual(self.req(p,cookie=cookie)[0],200,p)
 def test_local_mode_serves_without_login(self):
  # auth=None（本机模式）：不设登录门，页面与资源直接可达
  services=Services(store=self.store,covers=CoverService(self.root/'covers.sqlite3'),rates=RateService(self.root/'rates.sqlite3'))
  s=ThreadingHTTPServer(('127.0.0.1',0),make_handler(services));threading.Thread(target=s.serve_forever,daemon=True).start()
  try:
   c=http.client.HTTPConnection('127.0.0.1',s.server_port)
   # HTTP/1.1 keep-alive：同一连接复用前必须读完上一响应体
   c.request('GET','/',None,{'Host':f'127.0.0.1:{s.server_port}'});self.assertEqual(c.getresponse().read()[:15],b'<!doctype html>')
   c.request('GET','/assets/index.js',None,{'Host':f'127.0.0.1:{s.server_port}'});self.assertGreater(len(c.getresponse().read()),1000)
   c.close()
  finally:s.shutdown();s.server_close()

 def test_cover_endpoint_auth_and_immutable_cache(self):
  # 未登录取封面 → 401：封面虽已落盘仍属个人数据，走 API 鉴权
  self.assertEqual(self.req('/api/cover/0123456789abcdef.png')[0],401)
  status,h,_=self.req('/api/login',{'password':'test-password-12345'});cookie=h['Set-Cookie']
  png='data:image/png;base64,'+base64.b64encode(b'\x89PNGtestcoverbytes').decode()
  self.assertEqual(self.req('/api/records',{'title':'T','artist':'A','date':'2026-09-07','price':'10','currency':'CNY','cover':png},cookie)[0],200)
  _,_,body=self.req('/api/state',cookie=cookie);cover=json.loads(body)['records'][0]['cover']
  self.assertTrue(cover.startswith('/api/cover/'))
  status,h,img=self.req(cover,cookie=cookie)
  self.assertEqual(status,200);self.assertEqual(img,b'\x89PNGtestcoverbytes')
  self.assertEqual(h['Cache-Control'],'private, max-age=31536000, immutable')  # 内容寻址 → 可永久缓存
  self.assertEqual(self.req('/api/cover/zzzzzzzzzzzzzzzz.png',cookie=cookie)[0],404)
 def test_gzip_and_assets_etag(self):
  status,h,_=self.req('/api/login',{'password':'test-password-12345'});cookie=h['Set-Cookie']
  # gzip：声明 Accept-Encoding 的客户端拿压缩流（解压与原文一致）；未声明的拿原文
  status,h,body=self.req('/assets/index.js',cookie=cookie,**{'Accept-Encoding':'gzip'})
  self.assertEqual(status,200);self.assertEqual(h['Content-Encoding'],'gzip')
  status,h,raw=self.req('/assets/index.js',cookie=cookie)
  self.assertEqual(status,200);self.assertNotIn('Content-Encoding',h);self.assertGreater(len(raw),300000)
  self.assertEqual(gzip.decompress(body),raw)
  # ETag/304：未变更的构建产物第二次请求免重传；壳文件保持 no-store
  etag=h['ETag'];self.assertTrue(etag)
  status,h,_=self.req('/assets/index.js',cookie=cookie,**{'If-None-Match':etag})
  self.assertEqual(status,304);self.assertEqual(h['Cache-Control'],'no-cache')
  self.assertEqual(self.req('/theme.js')[1]['Cache-Control'],'no-store')
