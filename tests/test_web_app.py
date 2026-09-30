import unittest,tempfile,threading,json,http.client,sqlite3
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
 def req(self,path,body=None,cookie=None,origin=None,host=None):
  c=http.client.HTTPConnection('127.0.0.1',self.server.server_port);headers={}
  if cookie:headers['Cookie']=cookie
  if origin:headers['Origin']=origin
  if host:headers['Host']=host
  if body is not None:headers['Content-Type']='application/json'
  c.request('GET' if body is None else 'POST',path,None if body is None else json.dumps(body),headers);r=c.getresponse();out=(r.status,dict(r.getheaders()),r.read());c.close();return out
 def test_protected_data_and_session(self):
  for p in ['/api/state','/api/backup','/api/export']:self.assertEqual(self.req(p)[0],401)
  status,h,_=self.req('/api/login',{'password':'test-password-12345'});self.assertEqual(status,200);cookie=h['Set-Cookie'];self.assertIn('HttpOnly',cookie);self.assertIn('Secure',cookie)
  self.assertEqual(self.req('/api/state',cookie=cookie)[0],200)
  self.assertEqual(self.req('/api/logout',{},cookie=cookie)[0],200)
  self.assertEqual(self.req('/api/state',cookie=cookie)[0],401)
 def test_origins_and_hosts(self):
  self.assertEqual(self.req('/api/login',{'password':'test-password-12345'},origin='https://evil.test')[0],403)
  self.assertEqual(self.req('/',host='evil.test')[0],403)
  self.assertEqual(self.req('/',host='albums.example.test')[0],200)
 def test_loopback_port_remap_trusted(self):
  # Docker 端口映射：回环主机 + 任意端口可信；Origin 须与 Host 一致（挡 localhost 旁站 CSRF）
  self.assertEqual(self.req('/',host='127.0.0.1:18765')[0],200)
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
 def test_backup_restore_integrity_and_retention(self):
  for i in range(1,10):(self.backups.folder/f'2000-01-{i:02}.sqlite3').touch()
  self.backups.run();self.assertEqual(self.backups.status()['count'],7)
  p=sorted(self.backups.folder.glob('*.sqlite3'))[-1]
  with sqlite3.connect(p) as db:self.assertEqual(db.execute('PRAGMA integrity_check').fetchone()[0],'ok');self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='records'").fetchone())
  stamp=p.stat().st_mtime;self.backups.run();self.assertEqual(stamp,p.stat().st_mtime)
 def test_health_public_and_versioned(self):
  status,_,body=self.req('/api/health');self.assertEqual(status,200)
  d=json.loads(body);self.assertTrue(d['ok']);self.assertIn('version',d);self.assertEqual(d['schema'],3)
 def test_pwa_assets_and_no_private_cache(self):
  status,_,body=self.req('/manifest.webmanifest');self.assertEqual(status,200);self.assertEqual(json.loads(body)['display'],'standalone')
  for p in ['/sw.js','/offline.html','/icon-192.png','/icon-512.png','/vendor/heic2any.min.js','/login','/assets/index.js','/assets/index.css','/favicon.svg']:self.assertEqual(self.req(p)[0],200)
  self.assertEqual(self.req('/data/albums.sqlite3')[0],404)
