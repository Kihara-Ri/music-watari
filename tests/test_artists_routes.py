"""艺人资料 API：鉴权、Origin、参数校验、409 竞争、封面响应码与「慢外网不阻塞本地写」。"""
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

from covers import CoverService
from domain import ValidationError
from musicbrainz import MusicBrainzClient
from server import Services, make_handler
from server.artists import ArtistService
from server.routes import WRITE_LOCK
from security import Auth
from storage import Store

try:
    from test_artists import FakeClock, FakeOpener, artist_lookup, rg_entry
except ImportError:  # 直接以 tests.test_artists_routes 运行时
    from tests.test_artists import FakeClock, FakeOpener, artist_lookup, rg_entry

MBID_A = '11111111-1111-1111-1111-111111111111'
RG_1 = '33333333-3333-3333-3333-333333333333'


class ArtistRouteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.clock = FakeClock()
        self.opener = FakeOpener([
            (lambda u: '/ws/2/artist?query=' in u, lambda u: {'count': 1, 'artists': [dict(id=MBID_A, name='艺人', score=100)]}),
            (lambda u: '/ws/2/artist/' in u, lambda u: artist_lookup(MBID_A, '艺人')),
            (lambda u: '/ws/2/release-group?query=' in u, lambda u: {'count': 1, 'release-groups': [rg_entry(RG_1, '测试专辑', '2026-01-01')]}),
            (lambda u: '/ws/2/release-group?artist=' in u, lambda u: {'release-group-count': 1, 'release-groups': [rg_entry(RG_1, '测试专辑', '2026-01-01')]}),
        ])
        self.mb = MusicBrainzClient(opener=self.opener, clock=self.clock, sleep=self.clock.sleep)
        self.store = Store(self.root / 'albums.sqlite3')
        self.covers = CoverService(self.root / 'covers.sqlite3', mb=self.mb)
        self.artists = ArtistService(self.store, self.mb, self.covers, write_lock=WRITE_LOCK,
                                     clock=self.clock, sleep=self.clock.sleep)
        self.rid = self.store.save({'title': '测试专辑', 'artist': '艺人'})['ids'][0]
        services = Services(store=self.store, auth=Auth(self.root / 'auth.sqlite3'),
                            covers=self.covers, artists=self.artists)
        services.auth.set_password('test-password-12345')
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(services))
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        _, headers, _ = self.req('/api/login', {'password': 'test-password-12345'})
        self.cookie = headers['Set-Cookie']

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.tmp.cleanup()

    def req(self, path, body=None, cookie=None, origin=None, **extra):
        import http.client
        from urllib.parse import quote
        c = http.client.HTTPConnection('127.0.0.1', self.server.server_port)
        path = quote(path, safe='/?&=')  # 请求行必须 ASCII：中文参数转百分号编码
        headers = {'Content-Type': 'application/json'} if body is not None else {}
        if cookie: headers['Cookie'] = cookie
        if origin: headers['Origin'] = origin
        headers.update(extra)
        c.request('GET' if body is None else 'POST', path,
                  None if body is None else json.dumps(body), headers)
        r = c.getresponse(); out = (r.status, dict(r.getheaders()), r.read()); c.close()
        return out

    def test_new_endpoints_require_login(self):
        for path, body in [('/api/artists/profile?artist=x', None), ('/api/artists/catalog?artist=x', None),
                           ('/api/artists/artwork/' + RG_1, None), ('/api/artists/resolve', {'artist': 'x'}),
                           ('/api/artists/bind', {'artist': 'x'}), ('/api/artists/work-link', {'artist': 'x'}),
                           ('/api/artists/work-unlink', {'recordId': 'x'})]:
            status, _, _ = self.req(path, body)
            self.assertEqual(status, 401, path)

    def test_origin_and_params(self):
        self.assertEqual(self.req('/api/artists/resolve', {'artist': '艺人'}, cookie=self.cookie,
                                  origin='https://evil.test')[0], 403)
        self.assertEqual(self.req('/api/artists/resolve', {'artist': '外人'}, cookie=self.cookie)[0], 400)
        self.assertEqual(self.req('/api/artists/resolve', {'artist': ''}, cookie=self.cookie)[0], 400)
        self.assertEqual(self.req('/api/artists/bind', {'artist': '艺人', 'artistMbid': 'nope'}, cookie=self.cookie)[0], 400)
        self.assertEqual(self.req('/api/artists/catalog?artist=' + 'x' * 501, cookie=self.cookie)[0], 400)
        self.assertEqual(self.req('/api/artists/catalog?artist=艺人&offset=-1', cookie=self.cookie)[0], 400)

    def test_resolve_profile_catalog_link_roundtrip(self):
        status, _, body = self.req('/api/artists/resolve', {'artist': '艺人'}, cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['status'], 'resolved')  # 严格候选 + 作品证据 → 自动确认
        status, _, body = self.req('/api/artists/profile?artist=艺人', cookie=self.cookie)
        self.assertEqual(json.loads(body)['status'], 'bound')
        self.assertEqual(json.loads(body)['profile']['name'], '艺人')
        status, _, body = self.req('/api/artists/catalog?artist=艺人&offset=0', cookie=self.cookie)
        page = json.loads(body)
        self.assertTrue(page['complete']); self.assertEqual(page['total'], 1)
        # 关联作品：预期不符 → 409；正确 → ok
        link_body = {'artist': '艺人', 'recordId': self.rid, 'releaseGroupMbid': RG_1,
                     'recordArtist': '艺人', 'recordTitle': '测试专辑'}
        bad = dict(link_body, expectedReleaseGroupMbid=RG_1)
        self.assertEqual(self.req('/api/artists/work-link', bad, cookie=self.cookie)[0], 409)
        ok = dict(link_body, expectedReleaseGroupMbid=None)
        self.assertEqual(self.req('/api/artists/work-link', ok, cookie=self.cookie)[0], 200)
        # 绑定竞争：迟到的旧预期 → 409
        self.assertEqual(self.req('/api/artists/bind', {'artist': '艺人', 'artistMbid': MBID_A,
                                                        'expectedArtistMbid': None}, cookie=self.cookie)[0], 409)
        self.assertEqual(self.req('/api/artists/work-unlink', {'recordId': self.rid,
                                                               'expectedReleaseGroupMbid': '00000000-0000-0000-0000-000000000000'}, cookie=self.cookie)[0], 409)
        self.assertEqual(self.req('/api/artists/work-unlink', {'recordId': self.rid,
                                                               'expectedReleaseGroupMbid': RG_1}, cookie=self.cookie)[0], 200)

    def test_artwork_status_codes(self):
        page = {'fetchedAt': '2026-10-02T00:00:00', 'ts': 1e12, 'count': 1, 'works': [
            {'mbid': RG_1, 'title': '测试专辑', 'firstReleaseDate': '2026-01-01', 'primaryType': 'Album',
             'secondaryTypes': [], 'category': 'album', 'artistMbids': [MBID_A], 'sourceUrl': 'x'}]}
        self.artists._write_json_file(self.artists.cache_dir / 'release-groups' / f'{MBID_A}.0.json', page)
        self.assertEqual(self.req('/api/artists/artwork/not-a-uuid', cookie=self.cookie)[0], 400)
        self.assertEqual(self.req('/api/artists/artwork/99999999-9999-9999-9999-999999999999',
                                  cookie=self.cookie)[0], 400)  # 不在本地目录缓存
        self.covers.read = lambda url, limit: json.dumps({'images': []}).encode()
        self.assertEqual(self.req('/api/artists/artwork/' + RG_1, cookie=self.cookie)[0], 404)  # 来源无图
        self.assertEqual(self.req('/api/artists/artwork/' + RG_1, cookie=self.cookie)[0], 404)  # 负缓存
        def boom(url, limit): raise ValidationError('down')
        self.covers.read = boom
        (self.artists.cache_dir / 'artwork' / (RG_1 + '.miss.json')).unlink()  # 撤掉负缓存再试临时失败
        self.assertEqual(self.req('/api/artists/artwork/' + RG_1, cookie=self.cookie)[0], 503)  # 临时失败
        self.assertEqual(self.req('/api/artists/artwork/' + RG_1, cookie=self.cookie)[0], 503)  # 抑制期内
        jpeg = b'\xff\xd8\xff' + b'x' * 32
        def image_listing(url, limit):
            if 'release-group/' in url:
                return json.dumps({'images': [{'front': True, 'approved': True,
                    'thumbnails': {'500': 'https://coverartarchive.org/t.jpg'}}]}).encode()
            return jpeg
        self.covers.read = image_listing
        self.clock.now += 120  # 越过抑制期
        status, headers, body = self.req('/api/artists/artwork/' + RG_1, cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(headers['Content-Type'], 'image/jpeg')
        self.assertIn('max-age', headers.get('Cache-Control', ''))

    def test_slow_source_does_not_block_local_writes(self):
        self.store.bind_artist_identity('艺人', MBID_A, '艺人', 'manual', None)
        gate = threading.Event()
        entered = threading.Event()
        real_routes = self.opener.routes
        def slow_page(url):
            entered.set()
            gate.wait(10)
            return {'release-group-count': 0, 'release-groups': []}
        self.opener.routes = [(lambda u: '/ws/2/release-group?artist=' in u, slow_page)]
        result = {}
        def pull():
            result['status'], _, _ = self.req('/api/artists/catalog?artist=艺人&offset=0&refresh=1',
                                              cookie=self.cookie)
        worker = threading.Thread(target=pull); worker.start()
        self.assertTrue(entered.wait(5))  # 外网请求已挂起
        status, _, body = self.req('/api/records', {'title': '写入不被阻塞', 'artist': '艺人'},
                                   cookie=self.cookie)
        self.assertEqual(status, 200)  # 慢来源请求期间本地写照常完成
        self.assertTrue(worker.is_alive())
        gate.set(); worker.join(10)
        self.assertEqual(result['status'], 200)
        self.opener.routes = real_routes


    def test_records_write_enqueues_prewarm(self):
        # 账本写入后自动把未绑定艺人排入后台预取；响应先返回、入队紧随其后（不拖慢请求）
        self.assertEqual(self.req('/api/records', {'title': '新专辑', 'artist': '新艺人'},
                                  cookie=self.cookie)[0], 200)
        for _ in range(50):
            if '新艺人' in self.artists._prewarm_queued: break
            threading.Event().wait(0.05)
        self.assertIn('新艺人', self.artists._prewarm_queued)
        self.assertIn('新艺人', self.artists._prewarm_queue)
        # 已绑定/已入队的不再重复
        self.store.bind_artist_identity('新艺人', MBID_A, '新艺人', 'manual', None)
        self.assertEqual(self.req('/api/records', {'title': '再来一张', 'artist': '新艺人'},
                                  cookie=self.cookie)[0], 200)
        threading.Event().wait(0.2)
        self.assertEqual(self.artists._prewarm_queue.count('新艺人'), 1)


if __name__ == '__main__':
    unittest.main()
