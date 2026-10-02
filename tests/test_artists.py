"""艺人资料与作品目录服务：解析、归一、分类、分页、缓存、封面与节流。

全部使用 TemporaryDirectory 与可控假响应；不读取真实 data/，不做真实睡眠。
"""
import io
import json
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path

from covers import CoverService
from domain import ValidationError, ConflictError
from musicbrainz import MusicBrainzClient, RateLimited
from server.artists import (ArtistService, SourceUnavailableError, strict_key,
                            category_of, work_sort_key)

MBID_A = '11111111-1111-1111-1111-111111111111'
MBID_B = '22222222-2222-2222-2222-222222222222'
RG_1 = '33333333-3333-3333-3333-333333333333'
RG_2 = '44444444-4444-4444-4444-444444444444'
WALL = 1791000000.0

# 假 URL 的匹配串（musicbrainz.MusicBrainzClient 生成 /ws/2/<path>?<params>）
SEARCH_ARTIST = '/ws/2/artist?query='
SEARCH_RG = '/ws/2/release-group?query='
BROWSE_RG = '/ws/2/release-group?artist='


class FakeResponse:
    def __init__(self, body): self.body = body
    def read(self, n=-1): return self.body if n < 0 else self.body[:n]
    def __enter__(self): return self
    def __exit__(self, *args): return False


class FakeOpener:
    """routes: [(matcher(url) → bool, respond(url) → dict|bytes|(status, headers, bytes))]"""
    def __init__(self, routes):
        self.routes = routes
        self.calls = []

    def open(self, request, timeout=None):
        url = request.full_url
        self.calls.append(url)
        for matcher, respond in self.routes:
            if matcher(url): return self._wrap(respond(url))
        raise AssertionError('unexpected url: ' + url)

    @staticmethod
    def _wrap(payload):
        if isinstance(payload, tuple):
            status, headers, body = payload
            raise urllib.error.HTTPError('url', status, 'err', headers, io.BytesIO(body))
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        return FakeResponse(body)


class FakeClock:
    def __init__(self): self.now = 1000.0
    def __call__(self): return self.now
    def sleep(self, seconds): self.now += seconds


def artist_entry(mbid, name, **kw):
    return {'id': mbid, 'name': name, 'score': kw.get('score', 100), 'aliases': kw.get('aliases', []),
            'type': kw.get('type'), 'country': kw.get('country'), 'area': kw.get('area'),
            'disambiguation': kw.get('disambiguation')}


def artist_lookup(mbid, name, **kw):
    return {'id': mbid, 'name': name, 'type': kw.get('type', 'Group'), 'country': 'JP',
            'area': {'name': kw.get('area', 'Japan')},
            'life-span': kw.get('life_span', {'begin': '2000-03-31', 'end': None, 'ended': False}),
            'aliases': kw.get('aliases', []), 'genres': kw.get('genres', []),
            'disambiguation': kw.get('disambiguation', '')}


def rg_entry(gid, title, date=None, primary='Album', secondary=None, credit=(MBID_A,)):
    return {'id': gid, 'title': title, 'first-release-date': date, 'primary-type': primary,
            'secondary-types': secondary or [],
            'artist-credit': [{'name': 'A', 'artist': {'id': m, 'name': 'A'}} for m in credit]}


def raise_os_error(url):
    raise OSError('down')


class Harness:
    """临时数据目录 + 假 opener/时钟 的完整服务环境。"""

    def __init__(self, routes, resolve_budget=35.0):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.clock = FakeClock()
        self.opener = FakeOpener(routes)
        self.mb = MusicBrainzClient(opener=self.opener, clock=self.clock, sleep=self.clock.sleep)
        self.resolve_budget = resolve_budget

    def start(self):
        from storage import Store
        self.store = Store(self.root / 'albums.sqlite3')
        self.covers = CoverService(self.root / 'cover-cache.sqlite3', mb=self.mb)
        self.service = ArtistService(self.store, self.mb, self.covers,
                                     clock=self.clock, sleep=self.clock.sleep,
                                     wall=lambda: WALL + self.clock.now)
        self.service.resolve_budget = self.resolve_budget
        return self

    def buy(self, artist='艺人', title='测试专辑'):
        return self.store.save({'title': title, 'artist': artist})['ids'][0]

    def bind(self, mbid=MBID_A, artist='艺人'):
        self.store.bind_artist_identity(artist, mbid, artist, 'manual', None)

    def close(self): self.tmp.cleanup()


class StrictKeyTests(unittest.TestCase):
    def test_nfkc_casefold_space_only(self):
        self.assertEqual(strict_key('Ｂump of Chicken'), strict_key('bump  of chicken'))
        self.assertNotEqual(strict_key('Godspeed You! Black Emperor'), strict_key('Godspeed You Black Emperor'))
        self.assertNotEqual(strict_key('boom'), strict_key('Boom!'))

    def test_category_priority(self):
        self.assertEqual(category_of('Album', ['Compilation', 'Live']), 'compilation')
        self.assertEqual(category_of('Album', ['Live']), 'live')
        self.assertEqual(category_of('Album', ['Remix']), 'other')
        self.assertEqual(category_of('EP', []), 'ep')
        self.assertEqual(category_of('Single', []), 'single')
        self.assertEqual(category_of('Album', []), 'album')
        self.assertEqual(category_of(None, []), 'other')
        self.assertEqual(category_of('Broadcast', []), 'other')

    def test_sort_missing_date_last(self):
        works = [{'mbid': 'a', 'title': 'B', 'firstReleaseDate': None},
                 {'mbid': 'b', 'title': 'A', 'firstReleaseDate': '2001-01-01'},
                 {'mbid': 'c', 'title': 'A', 'firstReleaseDate': '2001-01-01'}]
        self.assertEqual([w['mbid'] for w in sorted(works, key=work_sort_key)], ['b', 'c', 'a'])


class ResolveTests(unittest.TestCase):
    def setUp(self):
        self._h = None
        self.addCleanup(lambda: self._h and self._h.close())

    def harness(self, routes, artist='Radiohead', title='OK Computer', **kw):
        self._h = h = Harness(routes, **kw).start()
        h.buy(artist=artist, title=title)
        return h

    def test_unique_strict_with_title_evidence_auto_confirms(self):
        h = self.harness([
            (lambda u: SEARCH_ARTIST in u, lambda u: {'count': 1, 'artists': [artist_entry(MBID_A, 'Radiohead')]}),
            (lambda u: SEARCH_RG in u, lambda u: {'count': 1, 'release-groups': [rg_entry(RG_1, 'OK Computer', '1997-05-21')]}),
        ])
        r = h.service.resolve('Radiohead')
        self.assertEqual(r['status'], 'resolved')
        self.assertEqual(r['binding']['method'], 'corroborated')
        self.assertEqual(h.store.artist_identities()['Radiohead']['artistMbid'], MBID_A)
        calls = len(h.opener.calls)
        self.assertEqual(h.service.resolve('Radiohead')['status'], 'resolved')  # 已绑定：不再搜索
        self.assertEqual(len(h.opener.calls), calls)

    def test_single_hit_without_evidence_stays_manual(self):
        h = self.harness([
            (lambda u: SEARCH_ARTIST in u, lambda u: {'count': 1, 'artists': [artist_entry(MBID_A, 'Radiohead')]}),
            (lambda u: SEARCH_RG in u, lambda u: {'count': 0, 'release-groups': []}),
        ])
        r = h.service.resolve('Radiohead')
        self.assertEqual(r['status'], 'ambiguous')  # 唯一命中但无作品证据 → 待确认
        self.assertEqual(len(r['candidates']), 1)
        self.assertIs(r['candidates'][0]['hasEvidence'], False)
        self.assertNotIn('Radiohead', h.store.artist_identities())

    def test_homonyms_ambiguous_and_manual_bind(self):
        h = self.harness([
            (lambda u: SEARCH_ARTIST in u, lambda u: {'count': 2, 'artists': [
                artist_entry(MBID_A, 'Nirvana', disambiguation='90s band'),
                artist_entry(MBID_B, 'Nirvana', disambiguation='60s band')]}),
            (lambda u: '/ws/2/artist/' in u, lambda u: artist_lookup(MBID_A, 'Nirvana')),
            (lambda u: SEARCH_RG in u, lambda u: {'count': 1, 'release-groups': [rg_entry(RG_1, '测试专辑')]}),
        ], artist='Nirvana', title='测试专辑')
        r = h.service.resolve('Nirvana')
        self.assertEqual(r['status'], 'ambiguous')
        self.assertEqual(len(r['candidates']), 2)
        evidence = {c['mbid']: c['hasEvidence'] for c in r['candidates']}
        self.assertIs(evidence[MBID_A], True)   # 同名候选：各自核对证据
        self.assertIs(evidence[MBID_B], False)
        self.assertNotIn('Nirvana', h.store.artist_identities())  # 同名不自动选第一项
        self.assertEqual(h.service.bind('Nirvana', MBID_B, None)['method'], 'manual')
        with self.assertRaises(ConflictError):
            h.service.bind('Nirvana', MBID_A, None)  # 预期不符 → 409
        self.assertEqual(h.service.bind('Nirvana', MBID_A, MBID_B)['artistMbid'], MBID_A)

    def test_incomplete_count_blocks_auto_confirm(self):
        h = self.harness([
            (lambda u: SEARCH_ARTIST in u, lambda u: {'count': 5, 'artists': [artist_entry(MBID_A, 'Radiohead')]}),
            (lambda u: SEARCH_RG in u, lambda u: {'count': 1, 'release-groups': [rg_entry(RG_1, 'OK Computer')]}),
        ])
        r = h.service.resolve('Radiohead')
        self.assertEqual(r['status'], 'ambiguous')
        self.assertFalse(r['evidenceComplete'])
        self.assertNotIn('Radiohead', h.store.artist_identities())

    def test_cv_credit_not_auto_substituted(self):
        h = self.harness([
            (lambda u: SEARCH_ARTIST in u, lambda u: {'count': 1, 'artists': [artist_entry(MBID_A, '雪ノ下雪乃')]}),
            (lambda u: SEARCH_RG in u, lambda u: {'count': 1, 'release-groups': [rg_entry(RG_1, 'テスト曲')]}),
        ], artist='雪ノ下雪乃(CV.早見沙織)', title='テスト曲')
        r = h.service.resolve('雪ノ下雪乃(CV.早見沙織)')
        # 拆分召回找到候选，但严格名称不一致：不自动替代身份，留候选人给用户确认
        self.assertEqual(r['status'], 'ambiguous')
        self.assertIsNone(r['candidates'][0]['hasEvidence'])
        self.assertNotIn('雪ノ下雪乃(CV.早見沙織)', h.store.artist_identities())

    def test_not_found_cached_one_hour(self):
        h = self.harness([(lambda u: SEARCH_ARTIST in u, lambda u: {'count': 0, 'artists': []})])
        self.assertEqual(h.service.resolve('Radiohead')['status'], 'not_found')
        h.service.resolve('Radiohead')
        self.assertEqual(len(h.opener.calls), 1)  # 第二次命中 1 小时未命中缓存
        h.clock.now += 3601
        h.service.resolve('Radiohead')
        self.assertEqual(len(h.opener.calls), 2)

    def test_unavailable_not_cached_as_missing(self):
        h = self.harness([(lambda u: SEARCH_ARTIST in u, raise_os_error)])
        with self.assertRaises(SourceUnavailableError):
            h.service.resolve('Radiohead')  # 解析异常不得包装成 not_found
        self.assertEqual(h.store.artist_identities(), {})
        h.opener.routes = [
            (lambda u: SEARCH_ARTIST in u, lambda u: {'count': 1, 'artists': [artist_entry(MBID_A, 'Radiohead')]}),
            (lambda u: SEARCH_RG in u, lambda u: {'count': 1, 'release-groups': [rg_entry(RG_1, 'OK Computer')]})]
        self.assertEqual(h.service.resolve('Radiohead')['status'], 'resolved')  # 瞬时失败不成为长期未命中

    def test_alias_match_and_evidence_budget(self):
        # 名称不同但官方别名一致 → 严格候选；预算耗尽 → 证据不完整，不自动确认
        h = self.harness([
            (lambda u: SEARCH_ARTIST in u, lambda u: {'count': 1, 'artists': [artist_entry(MBID_A, 'ミセカイノヒミツ')]}),
            (lambda u: '/ws/2/artist/' + MBID_A in u, lambda u: artist_lookup(MBID_A, 'ミセカイノヒミツ', aliases=[{'name': 'ミセカイのヒミツ'}])),
            (lambda u: SEARCH_RG in u, lambda u: {'count': 1, 'release-groups': [rg_entry(RG_1, 'テスト曲')]}),
        ], artist='ミセカイのヒミツ', title='テスト曲', resolve_budget=1.5)
        r = h.service.resolve('ミセカイのヒミツ')
        self.assertEqual(r['status'], 'ambiguous')
        self.assertFalse(r['evidenceComplete'])
        self.assertNotIn('ミセカイのヒミツ', h.store.artist_identities())

    def test_requires_known_artist_and_valid_params(self):
        h = self.harness([])
        with self.assertRaises(ValidationError): h.service.resolve('没有这位艺人')
        with self.assertRaises(ValidationError): h.service.resolve('')
        with self.assertRaises(ValidationError): h.service.resolve('x' * 501)


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self._h = None
        self.addCleanup(lambda: self._h and self._h.close())

    def harness(self, routes):
        self._h = h = Harness(routes).start()
        h.buy()
        h.bind()
        return h

    def test_person_life_span_and_precision(self):
        person = artist_lookup(MBID_A, '某人', type='Person',
                               life_span={'begin': '1955', 'end': '2014-06', 'ended': True},
                               aliases=[{'name': '别名'}], genres=[{'name': 'rock'}, {'name': 'jazz'}],
                               disambiguation='歌手')
        h = self.harness([(lambda u: '/ws/2/artist/' + MBID_A in u, lambda u: person)])
        prof = h.service.profile('艺人')['profile']
        self.assertEqual(prof['lifeSpan'], {'begin': '1955', 'end': '2014-06', 'ended': True})  # 精度保留，不补日
        self.assertEqual(prof['genres'], ['rock', 'jazz'])
        self.assertEqual(prof['aliases'], ['别名'])
        self.assertEqual(prof['sourceUrl'], 'https://musicbrainz.org/artist/' + MBID_A)
        calls = len(h.opener.calls)
        again = h.service.profile('艺人')  # 7 天缓存内零网络
        self.assertEqual(len(h.opener.calls), calls)
        self.assertEqual(again['sourceState']['cache'], 'fresh')

    def test_group_life_span_and_stale_flag(self):
        group = artist_lookup(MBID_A, '某团', life_span={'begin': '1990', 'end': '2005-03', 'ended': True})
        h = self.harness([(lambda u: '/ws/2/artist/' + MBID_A in u, lambda u: group)])
        self.assertEqual(h.service.profile('艺人')['profile']['lifeSpan']['end'], '2005-03')
        path = h.service.cache_dir / 'artist' / (MBID_A + '.json')
        entry = json.loads(path.read_text()); entry['ts'] -= 8 * 86400
        path.write_text(json.dumps(entry))
        stale = h.service.profile('艺人')
        self.assertEqual(stale['sourceState']['cache'], 'stale')
        self.assertTrue(stale['sourceState']['refreshSuggested'])

    def test_identity_invalid_keeps_binding_and_flags(self):
        h = self.harness([(lambda u: '/ws/2/artist/' + MBID_A in u, lambda u: (404, {}, b'{}'))])
        p = h.service.profile('艺人')
        self.assertEqual(p['identityError'], 'invalid')
        self.assertIsNotNone(p['identities'])  # 原绑定保留
        self.assertIsNone(p['profile'])

    def test_refresh_failure_keeps_cached_data(self):
        h = self.harness([(lambda u: '/ws/2/artist/' + MBID_A in u, lambda u: artist_lookup(MBID_A, '艺人'))])
        self.assertEqual(h.service.profile('艺人')['sourceState']['cache'], 'fresh')
        h.opener.routes = [(lambda u: True, raise_os_error)]
        failed = h.service.profile('艺人', refresh=True)
        self.assertEqual(failed['profile']['name'], '艺人')  # 保留缓存内容
        self.assertEqual(failed['sourceState']['cache'], 'stale')
        self.assertIsNotNone(failed['sourceState']['error'])

    def test_failure_without_cache_is_unavailable(self):
        h = self.harness([(lambda u: True, raise_os_error)])
        with self.assertRaises(SourceUnavailableError):
            h.service.profile('艺人')

    def test_collection_counts_links_and_staleness(self):
        h = self.harness([(lambda u: '/ws/2/artist/' in u, lambda u: artist_lookup(MBID_A, '艺人'))])
        rid1, rid2 = h.buy(title='同一张'), h.buy(title='同一张')
        h.buy(title='另一张')
        h.store.link_record_work(rid1, MBID_A, RG_1, None, '艺人', '同一张')
        h.store.link_record_work(rid2, MBID_A, RG_1, None, '艺人', '同一张')
        col = h.service.profile('艺人')['collection']
        self.assertEqual(col['counts']['holding'], 4)  # harness 预置 1 张 + 这里 3 张
        self.assertEqual(len(col['records']), 4)
        links = h.service.profile('艺人')['workLinks']
        self.assertEqual(links[rid1]['state'], 'confirmed')
        # 金额/笔记变化不影响关联
        rev = next(r for r in h.store.state()['records'] if r['id'] == rid1)['revision']
        h.store.save({'id': rid1, 'revision': rev, 'note': '备注', 'price': '100', 'date': '2026-01-01', 'currency': 'CNY'})
        self.assertEqual(h.service.profile('艺人')['workLinks'][rid1]['state'], 'confirmed')
        # 记录改名 → 旧关联待核对
        rev = next(r for r in h.store.state()['records'] if r['id'] == rid1)['revision']
        h.store.save({'id': rid1, 'revision': rev, 'title': '改名了'})
        self.assertEqual(h.service.profile('艺人')['workLinks'][rid1]['state'], 'stale')
        # 换绑到另一位艺人 → 全部待核对
        h.store.bind_artist_identity('艺人', MBID_B, '艺人', 'manual', MBID_A)
        self.assertTrue(all(v['state'] == 'stale'
                            for v in h.service.profile('艺人')['workLinks'].values()))

    def test_link_requires_artist_credit(self):
        listing = {'release-groups': [rg_entry(RG_1, '测试专辑', credit=(MBID_A,))]}
        h = self.harness([
            (lambda u: '/ws/2/release-group/' + RG_2 in u, lambda u: rg_entry(RG_2, '别人的', credit=(MBID_B,))),
        ])
        rid = h.store.state()['records'][0]['id']
        # RG_1 不在本地目录缓存：走来源核对，credit 含绑定艺人 → 允许
        h.opener.routes.append((lambda u: '/ws/2/release-group/' + RG_1 in u,
                                lambda u: rg_entry(RG_1, '测试专辑', credit=(MBID_A,))))
        self.assertEqual(h.service.work_link('艺人', rid, RG_1, None, '艺人', '测试专辑')['releaseGroupMbid'], RG_1)
        # credit 不含绑定艺人 → 拒绝
        with self.assertRaises(ValidationError):
            h.service.work_link('艺人', rid, RG_2, None, '艺人', '测试专辑')
        h.service.work_unlink(rid, RG_1)
        self.assertEqual(h.store.record_work_links(), {})

    def test_concurrent_profile_requests_merge(self):
        gate = threading.Event()
        calls = []
        def slow(url):
            calls.append(url); gate.wait(5)
            return artist_lookup(MBID_A, '艺人')
        h = self.harness([(lambda u: '/ws/2/artist/' + MBID_A in u, slow)])
        results = []
        def run(): results.append(h.service.profile('艺人')['profile']['name'])
        t1, t2 = threading.Thread(target=run), threading.Thread(target=run)
        t1.start(); threading.Event().wait(0.2); t2.start()
        threading.Event().wait(0.5)
        gate.set()
        t1.join(5); t2.join(5)
        self.assertEqual(results, ['艺人', '艺人'])
        self.assertEqual(len(calls), 1)  # 同一资料的并发请求合并成一次外网请求


def big_catalog(total=205):
    groups = []
    kinds = [('Album', []), ('EP', []), ('Single', []), ('Album', ['Compilation', 'Live']),
             ('Album', ['Live']), (None, []), ('Album', ['Soundtrack'])]
    for i in range(total):
        primary, secondary = kinds[i % len(kinds)]
        date = None if i % 37 == 0 else f'{1970 + i % 50}-{(i % 12) + 1:02d}-{(i % 28) + 1:02d}'
        groups.append(rg_entry(f'{i:08x}-1111-1111-1111-111111111111', f'作品 {i}', date, primary, secondary))
    return groups


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self._h = None
        self.addCleanup(lambda: self._h and self._h.close())

    def harness(self, routes):
        self._h = h = Harness(routes).start()
        h.buy()
        h.bind()
        return h

    @staticmethod
    def catalog_routes(groups, count=None):
        def page(url):
            params = dict(p.split('=', 1) for p in url.split('?')[1].split('&'))
            offset = int(params['offset'])
            return {'release-group-count': len(groups) if count is None else count,
                    'release-groups': groups[offset:offset + 100]}
        return [(lambda u: BROWSE_RG in u, page)]

    def walk(self, artist='艺人'):
        pages = [self._h.service.catalog(artist, 0)]
        while not pages[-1]['complete']:
            pages.append(self._h.service.catalog(artist, pages[-1]['nextOffset'],
                                                 round_id=pages[0]['roundId']))
        return pages

    def test_three_pages_205_items_complete_and_snapshot(self):
        groups = big_catalog(205)
        h = self.harness(self.catalog_routes(groups))
        pages = self.walk()
        self.assertEqual([p['returned'] for p in pages[:2]], [100, 100])
        self.assertFalse(pages[0]['complete'])
        last = pages[-1]
        self.assertTrue(last['complete'])
        works = last['works']
        self.assertEqual(len(works), 205)
        self.assertEqual(len({w['mbid'] for w in works}), 205)  # release-group 主键：一作品一项
        dates = [w['firstReleaseDate'] for w in works if w['firstReleaseDate']]
        self.assertEqual(dates, sorted(dates))  # 日期升序
        self.assertIsNone(works[-1]['firstReleaseDate'])  # 缺日期放末尾
        cats = {w['category'] for w in works}
        self.assertIn('compilation', cats); self.assertIn('live', cats); self.assertIn('other', cats)
        comp = next(w for w in works if w['category'] == 'compilation')
        self.assertIn('Live', comp['secondaryTypes'])  # 精选+现场：归精选，次类型标签保留
        unknown = next(w for w in works if w['primaryType'] is None)
        self.assertEqual(unknown['category'], 'other')  # 缺类型也保留
        # 快照生效：再次读取零网络、直接完整
        calls = len(h.opener.calls)
        again = h.service.catalog('艺人', 0)
        self.assertTrue(again['complete']); self.assertEqual(len(again['works']), 205)
        self.assertEqual(again['sourceState']['cache'], 'fresh')
        self.assertEqual(len(h.opener.calls), calls)
        self.assertFalse(any((h.service.cache_dir / 'rounds').glob('*.json')))
        # 过期快照：refreshSuggested 提示，内容继续可用
        path = h.service.cache_dir / 'catalog' / (MBID_A + '.json')
        entry = json.loads(path.read_text()); entry['ts'] -= 8 * 86400
        path.write_text(json.dumps(entry))
        stale = h.service.catalog('艺人', 0)
        self.assertTrue(stale['sourceState']['refreshSuggested'])
        self.assertEqual(len(stale['works']), 205)

    def test_duplicate_page_stops_without_snapshot(self):
        groups = big_catalog(205)
        h = self.harness([
            (lambda u: 'offset=0' in u, lambda u: {'release-group-count': 205, 'release-groups': groups[:100]}),
            (lambda u: True, lambda u: {'release-group-count': 205, 'release-groups': groups[:100]}),  # 重复页
        ])
        p1 = h.service.catalog('艺人', 0)
        p2 = h.service.catalog('艺人', 100, round_id=p1['roundId'])
        self.assertFalse(p2['complete'])
        self.assertIsNotNone(p2['roundError'])  # 停止自动推进，显示可重试状态
        self.assertFalse((h.service.cache_dir / 'catalog' / (MBID_A + '.json')).exists())

    def test_count_change_stops(self):
        groups = big_catalog(120)
        h = self.harness(self.catalog_routes(groups))
        p1 = h.service.catalog('艺人', 0)
        h.opener.routes = self.catalog_routes(groups, count=999)  # 来源 count 变化
        p2 = h.service.catalog('艺人', 100, round_id=p1['roundId'])
        self.assertIsNotNone(p2['roundError'])
        self.assertFalse(p2['complete'])

    def test_refresh_failure_keeps_old_complete_snapshot(self):
        groups = big_catalog(205)
        h = self.harness(self.catalog_routes(groups))
        self.assertTrue(self.walk()[-1]['complete'])
        snapshot = h.service.cache_dir / 'catalog' / (MBID_A + '.json')
        old = snapshot.read_text()
        h.opener.routes = [(lambda u: True, raise_os_error)]
        failed = h.service.catalog('艺人', 0, refresh=True)
        self.assertIsNotNone(failed['roundError'])
        self.assertEqual(failed['sourceState']['cache'], 'stale')  # 刷新失败：旧完整目录继续展示
        self.assertEqual(snapshot.read_text(), old)  # 不先清空旧目录
        ok = h.service.catalog('艺人', 0)
        self.assertTrue(ok['complete']); self.assertEqual(len(ok['works']), 205)

    def test_expired_round_is_conflict(self):
        h = self.harness([])
        h.service._write_json_file(h.service.cache_dir / 'rounds' / (MBID_A + '.json'),
                                   {'id': 'old-round', 'ts': WALL - 7200, 'count': None, 'seen': [], 'pages': {}})
        with self.assertRaises(ConflictError):
            h.service.catalog('艺人', 0, round_id='old-round')

    def test_empty_catalog_is_complete_empty(self):
        h = self.harness([(lambda u: BROWSE_RG in u,
                           lambda u: {'release-group-count': 0, 'release-groups': []})])
        p = h.service.catalog('艺人', 0)
        self.assertTrue(p['complete']); self.assertEqual(p['works'], []); self.assertEqual(p['total'], 0)

    def test_no_binding_reports_needs_resolution(self):
        fresh = Harness([]).start()
        self._h = fresh
        fresh.buy()
        self.assertEqual(fresh.service.catalog('艺人', 0)['status'], 'needs_resolution')
        self.assertEqual(fresh.service.profile('艺人')['status'], 'needs_resolution')

    def test_corrupt_cache_rebuilds(self):
        groups = big_catalog(205)
        h = self.harness(self.catalog_routes(groups))
        self.assertTrue(self.walk()[-1]['complete'])
        (h.service.cache_dir / 'catalog' / (MBID_A + '.json')).write_text('{broken json')
        fresh = h.service.catalog('艺人', 0)  # 损坏缓存被忽略并重建
        self.assertFalse(fresh['complete'])  # 重新走来源分页
        self.assertTrue(self.walk()[-1]['complete'])
        self.assertEqual(len(list(self._h.service.cache_dir.glob('catalog/*.json'))), 1)


class ArtworkTests(unittest.TestCase):
    def setUp(self):
        self._h = None
        self.addCleanup(lambda: self._h and self._h.close())

    def harness(self):
        self._h = h = Harness([]).start()
        h.buy()
        h.bind()
        page = {'fetchedAt': '2026-10-02T00:00:00', 'ts': WALL, 'count': 1, 'works': [{
            'mbid': RG_1, 'title': '测试专辑', 'firstReleaseDate': '2026-01-01', 'primaryType': 'Album',
            'secondaryTypes': [], 'category': 'album', 'artistMbids': [MBID_A], 'sourceUrl': 'x'}]}
        h.service._write_json_file(h.service.cache_dir / 'release-groups' / f'{MBID_A}.0.json', page)
        return h

    def test_artwork_roundtrip_negative_and_suppression(self):
        h = self.harness()
        jpeg = b'\xff\xd8\xff' + b'x' * 64
        reads = []
        def read(url, limit):
            reads.append(url)
            if 'coverartarchive.org/release-group/' in url:
                return json.dumps({'images': [{'front': True, 'approved': True,
                    'thumbnails': {'500': 'https://coverartarchive.org/thumb/500.jpg'}}]}).encode()
            return jpeg
        h.covers.read = read
        art = h.service.artwork(RG_1)
        self.assertEqual(art['mime'], 'image/jpeg')
        cached = h.service.cache_dir / 'artwork' / (RG_1 + '.jpg')
        self.assertTrue(cached.exists())
        calls = len(reads)
        h.service.artwork(RG_1)  # 文件缓存命中：零网络
        self.assertEqual(len(reads), calls)
        # 无图 → 1 天负缓存
        cached.unlink()
        h.covers.read = lambda url, limit: json.dumps({'images': []}).encode()
        self.assertIsNone(h.service.artwork(RG_1))
        calls = len(reads)
        self.assertIsNone(h.service.artwork(RG_1))
        self.assertEqual(len(reads), calls)
        # 临时失败 → 60 秒请求抑制，不写成「无图」
        def boom(url, limit): raise ValidationError('down')
        h.covers.read = boom
        h.clock.now += 86401
        with self.assertRaises(SourceUnavailableError):
            h.service.artwork(RG_1)
        with self.assertRaises(SourceUnavailableError):
            h.service.artwork(RG_1)

    def test_artwork_requires_cached_work(self):
        h = self.harness()
        with self.assertRaises(ValidationError):
            h.service.artwork('99999999-9999-9999-9999-999999999999')


class ThrottleTests(unittest.TestCase):
    def setUp(self):
        self._h = None
        self.addCleanup(lambda: self._h and self._h.close())

    def harness(self, routes):
        self._h = h = Harness(routes).start()
        h.buy()
        h.bind()
        return h

    def test_shared_client_paces_covers_and_artists(self):
        h = self.harness([
            (lambda u: '/ws/2/artist/' in u, lambda u: artist_lookup(MBID_A, '艺人')),
            (lambda u: '/ws/2/release/' in u, lambda u: {'releases': []}),
        ])
        h.covers.metadata('https://musicbrainz.org/ws/2/release/abc?fmt=json')  # covers 的 MB 路径
        h.service.profile('艺人', refresh=True)  # artists 路径
        start = h.clock.now
        h.covers.metadata('https://musicbrainz.org/ws/2/release/def?fmt=json')
        self.assertGreaterEqual(h.clock.now - start, 1.1)  # 真实请求之间保持 1.1s
        start = h.clock.now
        h.covers.metadata('https://musicbrainz.org/ws/2/release/abc?fmt=json')  # 命中缓存不等待
        self.assertEqual(h.clock.now, start)
        self.assertEqual(len(h.opener.calls), 3)

    def test_retry_after_cooldown(self):
        state = {'n': 0}
        def respond(url):
            state['n'] += 1
            if state['n'] == 1: return (429, {'Retry-After': '120'}, b'rate limited')
            return artist_lookup(MBID_A, '艺人')
        h = self.harness([(lambda u: '/ws/2/artist/' in u, respond)])
        with self.assertRaises(SourceUnavailableError):
            h.service.profile('艺人', refresh=True)
        calls = len(h.opener.calls)
        with self.assertRaises(SourceUnavailableError):
            h.service.profile('艺人', refresh=True)  # 冷却期直接可重试，不打网络
        self.assertEqual(len(h.opener.calls), calls)
        h.clock.now += 121
        self.assertEqual(h.service.profile('艺人', refresh=True)['profile']['name'], '艺人')

    def test_rejects_non_api_hosts(self):
        h = self.harness([])
        from musicbrainz import BadSource
        for url in ('http://musicbrainz.org/ws/2/artist?fmt=json',
                    'https://evil.example.com/ws/2/artist?fmt=json',
                    'https://musicbrainz.org/other/artist?fmt=json'):
            with self.assertRaises(BadSource):
                h.mb.get_url(url)


if __name__ == '__main__':
    unittest.main()
