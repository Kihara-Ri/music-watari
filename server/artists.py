"""艺人资料与作品目录：身份解析、资料归一、目录分页、文件缓存与 CAA 封面。

职责边界：MusicBrainz 网络只经 musicbrainz.MusicBrainzClient（全应用共用节流）；
账本写入只走 storage.py 的事务方法，且在网络核验完成后于短写锁内执行；
本模块自己的文件缓存都在数据目录 artist-cache/ 下，可随时重建，不进备份。
"""
import hashlib
import json
import re
import threading
import time
import unicodedata
from pathlib import Path

from domain import ValidationError, ConflictError
from covers import artwork_url
from musicbrainz import (SourceUnavailable, SourceNotFound, RateLimited, BudgetExceeded,
                         BadSource, is_uuid, lucene_quote)
from storage import uid, now

PROFILE_TTL = 7 * 86400      # 艺人资料 / 目录页缓存有效期
ROUND_TTL = 3600             # 刷新轮次时效；过期后分页请求 409，重新开始
MISS_TTL = 3600              # 名称未命中缓存
AMBIGUOUS_TTL = 600          # 同名候选解析结果缓存：后台预取的成果，打开时直接呈现
ARTWORK_TTL = 30 * 86400     # 封面成功缓存
ARTWORK_MISS_TTL = 86400     # 来源无图负缓存
FAIL_SUPPRESS = 60           # 临时失败请求抑制（内存）
RESOLVE_BUDGET = 35.0        # 证据核对总预算（秒，含节流等候）
MAX_TITLE_PROBES = 2         # 每次解析最多使用的去重本地标题
SEARCH_LIMIT = 10
PAGE_LIMIT = 100

HOLDING_STATUSES = ('domestic', 'overseas', 'transit')


class SourceUnavailableError(Exception):
    """来源暂时不可用且无可用缓存；路由层映射为 503。"""


def strict_key(name):
    """严格名称核对：NFKC + casefold + 首尾与连续空白归一；不删除标点。"""
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(name)).strip().casefold())


def category_of(primary, secondary):
    """每项作品只进一个主分类；原始次类型继续随条目保留。"""
    sec = {str(s).casefold() for s in secondary or []}
    if 'compilation' in sec: return 'compilation'
    if 'live' in sec: return 'live'
    if sec: return 'other'
    return {'album': 'album', 'ep': 'ep', 'single': 'single'}.get(str(primary or '').casefold(), 'other')


def normalize_artist(a):
    span = a.get('life-span') or {}
    ended = span.get('ended')
    return {
        'mbid': a['id'],
        'name': str(a.get('name', '')),
        'aliases': [str(al.get('name')) for al in a.get('aliases', []) if isinstance(al, dict) and al.get('name')],
        'type': a.get('type') or None,
        'area': (a.get('area') or {}).get('name') or None,
        'lifeSpan': {'begin': span.get('begin') or None, 'end': span.get('end') or None,
                     'ended': ended if isinstance(ended, bool) else None},
        'genres': [str(g.get('name')) for g in a.get('genres', []) if isinstance(g, dict) and g.get('name')],
        'disambiguation': a.get('disambiguation') or None,
        'sourceUrl': 'https://musicbrainz.org/artist/' + a['id'],
    }


def normalize_work(g):
    gid = g.get('id')
    if not is_uuid(gid): return None
    secondary = sorted({str(s) for s in g.get('secondary-types', []) if s})
    primary = g.get('primary-type') or None
    credit = [c for c in g.get('artist-credit', []) if isinstance(c, dict)]
    return {
        'mbid': gid,
        'title': str(g.get('title', '')),
        'firstReleaseDate': g.get('first-release-date') or None,
        'primaryType': primary,
        'secondaryTypes': secondary,
        'category': category_of(primary, secondary),
        'artistMbids': [c['artist']['id'] for c in credit
                        if isinstance(c.get('artist'), dict) and is_uuid(c['artist'].get('id'))],
        'sourceUrl': 'https://musicbrainz.org/release-group/' + gid,
    }


def work_sort_key(w):
    # 完整目录按日期升序；缺日期放末尾，同日按标题、MBID 稳定排序。
    return (w.get('firstReleaseDate') or '9999-12-31', str(w.get('title', '')).casefold(), w['mbid'])


def _image_ext(data):
    if data.startswith(b'\xff\xd8\xff'): return 'jpg', 'image/jpeg'
    if data.startswith(b'\x89PNG\r\n\x1a\n'): return 'png', 'image/png'
    if data.startswith(b'RIFF') and data[8:12] == b'WEBP': return 'webp', 'image/webp'
    raise ValidationError('返回的文件不是受支持的封面图片')


class ArtistService:
    resolve_budget = RESOLVE_BUDGET

    def __init__(self, store, mb, covers, write_lock=None,
                 clock=time.monotonic, sleep=time.sleep, wall=time.time):
        self.store = store
        self.mb = mb
        self.covers = covers
        self.write_lock = write_lock or threading.Lock()
        self._clock = clock
        self._sleep = sleep
        self._wall = wall
        self.cache_dir = Path(store.path).parent / 'artist-cache'
        # 相同资料/相同目录页的并发请求合并：一次点击只产生一次外网请求
        self._inflight_lock = threading.Lock()
        self._inflight = {}
        # 临时失败抑制（内存即可：重启后多试一次无害）
        self._suppress = {}
        # CAA 目录请求的自有节流（coverartarchive.org 不在 ws/2 客户端管辖内）
        self._caa_lock = threading.Lock()
        self._caa_last = float('-inf')
        # 本地目录缓存中出现过的作品 ID（懒构建；快照写入后失效）
        self._known_lock = threading.Lock()
        self._known = None
        # ── 后台预取：库内出现未绑定艺人时自动解析/缓存，用户打开抽屉即有所需资料 ──
        # 队列只存名字；重试节奏在内存（重启后由「未绑定名单」扫描自然重建）
        self.prewarm_enabled = True          # 测试可整体关掉
        self.prewarm_retry = 900.0           # 单个艺人失败后的最早重试间隔（秒）
        self.prewarm_retry_short = 75.0      # 限流冷却跟随退避：冷却结束即重试
        self.prewarm_gap = 2.0               # 艺人之间的额外间隔（配合客户端 1.1s 节流）
        self._prewarm_lock = threading.Lock()
        self._prewarm_queue = []
        self._prewarm_queued = set()
        self._prewarm_next = {}              # artist → 最早重试时刻（clock 口径）
        self._prewarm_wake = threading.Event()
        self._prewarm_thread = None

    # ── 基础工具 ──
    def _records_of(self, name):
        with self.store.connect() as db:
            return [r for r in self.store.rows(db, 'records') if r.get('artist') == name]

    def _check_artist(self, artist):
        if not isinstance(artist, str): raise ValidationError('艺人名不正确')
        name = artist.strip()
        if not 1 <= len(name) <= 500: raise ValidationError('艺人名长度应为 1–500 字')
        if not self._records_of(name): raise ValidationError('库内没有这位艺人的专辑')
        return name

    def _binding(self, name):
        return self.store.artist_identities().get(name)

    def _read_json_file(self, path):
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError, UnicodeError):
            return None  # 缓存损坏：忽略并按缺失重建，不影响绑定、账本或启动
        return data if isinstance(data, dict) else None

    def _write_json_file(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f'{path.name}.{uid()}.tmp')  # 并发合并后可能多方写同一目标：tmp 必须唯一
        tmp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        tmp.replace(path)

    def _fresh(self, entry, ttl):
        return isinstance(entry.get('ts'), (int, float)) and self._wall() - entry['ts'] < ttl

    def _single(self, key, fn):
        """同 key 并发请求合并：第一个执行，其余等待共享结果。"""
        with self._inflight_lock:
            entry = self._inflight.get(key)
            if entry is None:
                entry = (threading.Event(), {})
                self._inflight[key] = entry
                owner = True
            else:
                owner = False
        if not owner:
            entry[0].wait(120)
            if 'error' in entry[1]: raise entry[1]['error']
            return entry[1]['value']
        try:
            value = fn()
            entry[1]['value'] = value
            return value
        except BaseException as exc:
            entry[1]['error'] = exc
            raise
        finally:
            with self._inflight_lock:
                self._inflight.pop(key, None)
            entry[0].set()

    def _suppressed(self, key):
        deadline = self._suppress.get(key)
        return deadline is not None and self._clock() < deadline

    def _mark_suppress(self, key):
        self._suppress[key] = self._clock() + FAIL_SUPPRESS

    @staticmethod
    def _state(fetched_at=None, cache='missing', refresh_suggested=False, error=None):
        return {'fetchedAt': fetched_at, 'cache': cache,
                'refreshSuggested': refresh_suggested, 'error': error}

    # ── 身份解析 ──
    def resolve(self, artist, search_name=None, force=False):
        name = self._check_artist(artist)
        binding = self._binding(name)
        if binding and not force:  # 已有绑定直接使用，不重复搜索名称；更换艺人走 force
            return {'status': 'resolved', 'artist': name, 'binding': binding,
                    'candidates': [], 'evidenceComplete': True, 'searchCount': None}
        query = search_name if search_name is not None else name
        if not isinstance(query, str) or not 1 <= len(query.strip()) <= 500:
            raise ValidationError('搜索名称不正确')
        query = query.strip()
        titles = []
        for record in self._records_of(name):
            title = strict_key(record.get('title', ''))
            if title and title not in titles: titles.append(title)
        title_context = hashlib.sha256(json.dumps(sorted(titles), ensure_ascii=False).encode()).hexdigest()
        miss_path = self.cache_dir / 'miss' / (hashlib.sha256(strict_key(query).encode()).hexdigest()[:20] + '.json')
        miss = self._read_json_file(miss_path)
        if miss and not force and not self._binding(name):  # force=更换艺人：始终重新解析
            # 未命中/同名候选的解析成果短期复用（后台预取的热身成果）；一有绑定立即失效
            if miss.get('status') == 'not_found' and self._fresh(miss, MISS_TTL):
                return {'status': 'not_found', 'artist': name, 'candidates': [],
                        'evidenceComplete': True, 'searchCount': 0}
            if miss.get('status') == 'ambiguous' and self._fresh(miss, AMBIGUOUS_TTL):
                cached = dict(miss.get('result') or {}, artist=name)
                rows = cached.get('candidates') or []
                if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict) and is_uuid(rows[0].get('mbid')):
                    return self._resolve_candidate(name, rows[0], 'single',
                                                   cached.get('evidenceComplete', False), cached.get('searchCount'))
                if miss.get('policy') == 'single-or-work-v2' and miss.get('titleContext') == title_context and rows:
                    return cached
        deadline = self._clock() + self.resolve_budget
        try:
            search = self._single('search:' + strict_key(query),
                                  lambda: self.mb.get('artist', {'query': 'artist:' + lucene_quote(query),
                                                                 'fmt': 'json', 'limit': SEARCH_LIMIT},
                                                     budget=deadline - self._clock()))
        except (SourceUnavailable, BadSource) as exc:
            raise SourceUnavailableError(str(exc)) from None
        raw = [a for a in search.get('artists', []) if isinstance(a, dict)]
        search_count = search.get('count')
        complete = isinstance(search_count, int) and search_count <= len(raw)
        target = strict_key(name)
        candidates = []
        seen_ids = set()
        for a in raw:
            gid = a.get('id')
            if not is_uuid(gid) or gid in seen_ids: continue
            seen_ids.add(gid)
            names = [a.get('name', '')] + [al.get('name', '') for al in a.get('aliases', []) if isinstance(al, dict)]
            candidates.append({'mbid': gid, 'name': str(a.get('name', '')), 'aliases': [],
                               'type': a.get('type') or None,
                               'area': (a.get('area') or {}).get('name') or a.get('country') or None,
                               'disambiguation': a.get('disambiguation') or None, 'score': a.get('score'),
                               'hasEvidence': None,
                               'strict': any(n and strict_key(n) == target for n in names)})
        expected = binding['artistMbid'] if binding and force else None
        if len(candidates) == 1:
            # 用户规则：唯一候选直接采用；本地艺人字段保持原样。
            return self._resolve_candidate(name, candidates[0], 'single', complete,
                                           search_count, expected)
        # 多候选用本地专辑反查全部返回的身份，不依赖名字是否严格相同。
        # 同名候选共享查询结果，但分别验证作品标题和 artist-credit 的 MBID。
        probe_cache = {}
        evidence = {}
        for c in candidates:
            evidence[c['mbid']] = (self._title_evidence(c['mbid'], c['name'], titles,
                                                      deadline, probe_cache) if titles else False)
            if evidence[c['mbid']] is None: complete = False
        winners = [c for c in candidates if evidence.get(c['mbid']) is True]
        if len(winners) == 1 and all(v is not None for v in evidence.values()):
            return self._resolve_candidate(name, winners[0], 'corroborated', complete,
                                           search_count, expected)
        if not candidates:
            # 名称未命中只缓存 1 小时；证据核对不完整时不缓存，避免把失败当「无此艺人」
            if complete:
                self._write_json_file(miss_path, {'query': query, 'ts': self._wall(), 'status': 'not_found'})
            return {'status': 'not_found', 'artist': name, 'candidates': [],
                    'evidenceComplete': complete, 'searchCount': search_count}
        for c in candidates:
            c['hasEvidence'] = evidence.get(c['mbid'])
        result = {'status': 'ambiguous', 'artist': name, 'candidates': candidates,
                  'evidenceComplete': complete, 'searchCount': search_count}
        # 短缓存（不含 searchCount 之外的易变上下文）；绑定后由绑定短路覆盖
        self._write_json_file(miss_path, {'query': query, 'ts': self._wall(),
                                          'status': 'ambiguous', 'policy': 'single-or-work-v2',
                                          'titleContext': title_context, 'result': result})
        return result

    def _resolve_candidate(self, name, candidate, method, complete, search_count, expected=None):
        try:
            with self.write_lock:
                binding = self.store.bind_artist_identity(name, candidate['mbid'],
                                                          candidate['name'] or name, method, expected)
        except ConflictError:
            binding = self._binding(name)  # 搜索期间身份被修改：保留后来确认的结果
        return {'status': 'resolved', 'artist': name, 'binding': binding,
                'candidates': [], 'evidenceComplete': complete, 'searchCount': search_count}

    def _title_evidence(self, mbid, artist_hint, titles, deadline, cache):
        """本地标题（+候选艺人名提高召回）检索 release-group，客户端核对返回的
        artist-credit——查询带 artist 词只影响召回，证据仍以返回的 credit 为准。
        同名候选的探测查询相同：结果按 (艺人名, 标题) 共享，各自核对自己的 MBID。"""
        for title in titles[:MAX_TITLE_PROBES]:
            key = (strict_key(artist_hint), title)
            if key not in cache:
                try:
                    data = self.mb.get('release-group', {'query': 'releasegroup:' + lucene_quote(title)
                                                         + ' AND artist:' + lucene_quote(artist_hint),
                                                         'fmt': 'json', 'limit': 10},
                                       budget=deadline - self._clock())
                    groups = data.get('release-groups', []) if isinstance(data, dict) else []
                    cache[key] = [(strict_key(g.get('title', '')),
                                   [c['artist']['id'] for c in g.get('artist-credit', [])
                                    if isinstance(c, dict) and isinstance(c.get('artist'), dict)])
                                  for g in groups if isinstance(g, dict)]
                except BudgetExceeded:
                    cache[key] = None
                except (SourceUnavailable, BadSource):
                    cache[key] = None
            rows = cache[key]
            if rows is None: return None
            for t, credit_ids in rows:
                if t == title and mbid in credit_ids: return True
        return False

    # ── 人工绑定 ──
    def bind(self, artist, artist_mbid, expected_artist_mbid):
        name = self._check_artist(artist)
        if not is_uuid(artist_mbid): raise ValidationError('艺人编号不正确')
        try:
            detail = self._single('artist:' + artist_mbid,
                                  lambda: self.mb.get('artist/' + artist_mbid,
                                                      {'inc': 'aliases+genres', 'fmt': 'json'}))
        except SourceNotFound:
            raise ValidationError('资料库中不存在这个艺人编号') from None
        except (SourceUnavailable, BadSource) as exc:
            raise SourceUnavailableError(str(exc)) from None
        source_name = str(detail.get('name') or artist_mbid)
        with self.write_lock:
            return self.store.bind_artist_identity(name, artist_mbid, source_name,
                                                   'manual', expected_artist_mbid)

    # ── 资料面板 ──
    def profile(self, artist, refresh=False):
        name = self._check_artist(artist)
        binding = self._binding(name)
        if not binding:
            return {'artist': name, 'status': 'needs_resolution', 'profile': None, 'identityError': None,
                    'identities': None, 'collection': self._collection(name), 'workLinks': {},
                    'sourceState': self._state()}
        mbid = binding['artistMbid']
        path = self.cache_dir / 'artist' / (mbid + '.json')
        cached = self._read_json_file(path)
        if cached and not refresh:
            fresh = self._fresh(cached, PROFILE_TTL)
            state = self._state(cached.get('fetchedAt'), 'fresh' if fresh else 'stale', not fresh)
            return self._profile_response(name, binding, cached.get('data'), state)
        try:
            raw = self._single('artist:' + mbid,
                               lambda: self.mb.get('artist/' + mbid, {'inc': 'aliases+genres', 'fmt': 'json'}))
        except SourceNotFound:
            # 绑定的 MBID 已失效：保留原绑定，标为需重新确认；旧缓存仍可显示
            state = self._state(cached.get('fetchedAt') if cached else None,
                                'stale' if cached else 'missing', False, '资料身份需重新确认')
            resp = self._profile_response(name, binding, cached.get('data') if cached else None, state)
            resp['identityError'] = 'invalid'
            return resp
        except (SourceUnavailable, BadSource) as exc:
            if cached:  # 网络失败但有缓存：保留内容，标记来源失败
                state = self._state(cached.get('fetchedAt'), 'stale', True, str(exc))
                return self._profile_response(name, binding, cached.get('data'), state)
            raise SourceUnavailableError(str(exc)) from None
        data = normalize_artist(raw)
        fetched_at = now()
        self._write_json_file(path, {'fetchedAt': fetched_at, 'ts': self._wall(), 'data': data})
        return self._profile_response(name, binding, data, self._state(fetched_at, 'fresh'))

    def _profile_response(self, name, binding, data, state):
        return {'artist': name, 'status': 'bound', 'profile': data, 'identityError': None,
                'identities': binding, 'collection': self._collection(name),
                'workLinks': self._work_links_view(name, binding), 'sourceState': state}

    def _collection(self, name):
        recs = self._records_of(name)
        counts = {'holding': 0, 'shipping': 0, 'sold': 0}
        payload = []
        for r in recs:
            if r['status'] == 'trash': continue
            if r['status'] in HOLDING_STATUSES: counts['holding'] += 1
            elif r['status'] == 'shipping': counts['shipping'] += 1
            elif r['status'] == 'sold': counts['sold'] += 1
            payload.append({k: r.get(k, '') for k in ('id', 'title', 'status', 'cover',
                                                      'version', 'pressing', 'obi')})
        return {'counts': counts, 'records': payload}

    def _work_links_view(self, name, binding):
        """关联展示视图：记录改名/换绑后旧关联标为 stale；不存在的记录忽略，不复活。"""
        links = self.store.record_work_links()
        recs = {r['id']: r for r in self._records_of(name)}
        out = {}
        mbid = binding['artistMbid']
        for rid, link in links.items():
            if not isinstance(link, dict): continue
            r = recs.get(rid)
            if r is None: continue
            confirmed = (link.get('artistMbid') == mbid
                         and link.get('recordArtist') == r.get('artist')
                         and link.get('recordTitle') == r.get('title'))
            out[rid] = {'releaseGroupMbid': link.get('releaseGroupMbid'), 'artistMbid': link.get('artistMbid'),
                        'state': 'confirmed' if confirmed else 'stale'}
        return out

    # ── 作品目录 ──
    def catalog(self, artist, offset, refresh=False, round_id=None):
        name = self._check_artist(artist)
        try:
            offset = int(offset)
        except (TypeError, ValueError):
            raise ValidationError('分页参数不正确') from None
        if offset < 0: raise ValidationError('分页参数不正确')
        binding = self._binding(name)
        if not binding:
            return {'artist': name, 'status': 'needs_resolution'}
        mbid = binding['artistMbid']
        snap_path = self.cache_dir / 'catalog' / (mbid + '.json')
        snap = self._read_json_file(snap_path)
        if snap and not refresh:
            # 默认先返回已有缓存；过期快照带 refreshSuggested，由前端在抽屉内后台刷新
            fresh = self._fresh(snap, PROFILE_TTL)
            state = self._state(snap.get('fetchedAt'), 'fresh' if fresh else 'stale', not fresh)
            works = [w for w in snap.get('works', []) if isinstance(w, dict)]
            if offset == 0:
                return self._page(mbid, None, 0, works, len(works), len(works), None, True, None, state)
            chunk = works[offset:offset + PAGE_LIMIT]
            nxt = offset + len(chunk)
            return self._page(mbid, None, offset, chunk, len(chunk), len(works),
                              nxt if nxt < len(works) else None, True, None, state)
        rnd = self._read_json_file(self.cache_dir / 'rounds' / (mbid + '.json'))
        if round_id is not None:
            if (not isinstance(rnd, dict) or rnd.get('id') != round_id
                    or not self._fresh(rnd, ROUND_TTL)):
                raise ConflictError('刷新轮次已过期，请重新开始')
        elif isinstance(rnd, dict) and self._fresh(rnd, ROUND_TTL):
            pass  # 仍有进行中的轮次：refresh=1 不另起炉灶，继续同一轮
        else:
            rnd = {'id': uid(), 'ts': self._wall(), 'count': None, 'seen': [], 'pages': {}}
        state = self._state(snap.get('fetchedAt') if snap else None, 'stale' if snap else 'missing')
        try:
            page = self._catalog_page(mbid, offset, rnd, bool(refresh), state)
        except (SourceUnavailable, BadSource) as exc:
            if snap:
                # 刷新失败：保留旧完整快照供继续展示，明确标记来源失败与轮次错误
                return self._page(mbid, rnd.get('id'), offset, [], 0, len(snap.get('works', [])),
                                  None, False, str(exc),
                                  self._state(snap.get('fetchedAt'), 'stale', False, str(exc)))
            raise SourceUnavailableError(str(exc)) from None
        if page['complete']:
            works = sorted(page.pop('_all'), key=work_sort_key)
            fetched_at = now()
            self._write_json_file(snap_path, {'fetchedAt': fetched_at, 'ts': self._wall(), 'works': works})
            with self._known_lock: self._known = None
            (self.cache_dir / 'rounds' / (mbid + '.json')).unlink(missing_ok=True)
            return self._page(mbid, None, offset, works, len(works), len(works), None, True, None,
                              self._state(fetched_at, 'fresh'))
        self._write_json_file(self.cache_dir / 'rounds' / (mbid + '.json'), rnd)
        return page

    def _catalog_page(self, mbid, offset, rnd, refresh, state):
        page_path = self.cache_dir / 'release-groups' / f'{mbid}.{offset}.json'
        cached_page = None if refresh else self._read_json_file(page_path)
        if cached_page and isinstance(cached_page.get('count'), int):
            return self._finish_page(mbid, rnd, offset, cached_page['works'], cached_page['count'], state)
        data = self._single(f'rg:{mbid}:{offset}:{bool(refresh)}',
                            lambda: self.mb.get('release-group',
                                                {'artist': mbid, 'inc': 'artist-credits',
                                                 'release-group-status': 'website-default',
                                                 'limit': PAGE_LIMIT, 'offset': offset, 'fmt': 'json'}))
        if not isinstance(data, dict):
            raise BadSource('资料库返回了无法读取的目录')
        count = data.get('release-group-count', data.get('count'))
        groups = data.get('release-groups', [])
        if not isinstance(count, int) or not isinstance(groups, list):
            raise BadSource('资料库返回了无法读取的目录')
        works = [w for w in (normalize_work(g) for g in groups if isinstance(g, dict)) if w]
        # 空页可能是瞬时异常：不写入长期缓存，重试时重新请求来源
        if works or offset >= count:
            self._write_json_file(page_path, {'fetchedAt': now(), 'ts': self._wall(),
                                              'count': count, 'works': works})
        return self._finish_page(mbid, rnd, offset, works, count, state)

    def _finish_page(self, mbid, rnd, offset, works, count, state):
        works = [w for w in works if isinstance(w, dict)]
        returned = len(works)
        round_error = None
        already = str(offset) in rnd.get('pages', {})  # 本轮已记录的页被再次读取：正常续传
        if rnd.get('count') is None:
            rnd['count'] = count
        elif count != rnd.get('count'):
            round_error = '来源目录数量发生变化，请重新开始刷新'
        if round_error is None and returned == 0 and offset < count:
            round_error = '来源返回了空页，请重试'
        seen = list(rnd.get('seen', []))
        new_ids = [w['mbid'] for w in works if w['mbid'] not in set(seen)]
        if round_error is None and not already and not new_ids and offset + returned < count:
            round_error = '来源返回了重复内容，请重新开始刷新'
        total = count
        nxt = offset + returned if (round_error is None and offset + returned < total) else None
        complete = (round_error is None and offset + returned >= total
                    and len(set(seen)) + len(new_ids) == total)
        if round_error is None:
            rnd.setdefault('pages', {})[str(offset)] = returned
            rnd['seen'] = seen + new_ids
            rnd['ts'] = self._wall()
        page = self._page(mbid, rnd['id'], offset, works, returned, total, nxt,
                          complete, round_error, state)
        if complete:
            # 汇总本轮所有页的唯一作品；只有与来源 count 一致才宣称本轮完整
            merged = {}
            for k in sorted(rnd['pages'], key=int):
                entry = self._read_json_file(self.cache_dir / 'release-groups' / f'{mbid}.{k}.json')
                for w in (entry or {}).get('works', []):
                    if isinstance(w, dict) and is_uuid(w.get('mbid')): merged[w['mbid']] = w
            if len(merged) != total:
                page['complete'] = False
                page['roundError'] = '来源目录数量与读取结果不一致，请重新开始刷新'
            else:
                page['_all'] = list(merged.values())
        return page

    @staticmethod
    def _page(mbid, round_id, offset, works, returned, total, next_offset, complete, round_error, state):
        return {'artistMbid': mbid, 'roundId': round_id, 'offset': offset,
                'returned': returned, 'total': total, 'nextOffset': next_offset,
                'works': works, 'complete': complete, 'roundError': round_error,
                'sourceState': state}

    # ── 副本-作品关联 ──
    def work_link(self, artist, record_id, rg_mbid, expected_rg, record_artist, record_title):
        name = self._check_artist(artist)
        binding = self._binding(name)
        if not binding: raise ValidationError('请先确认这位艺人的身份')
        if not is_uuid(rg_mbid): raise ValidationError('作品编号不正确')
        if not self._rg_credits_artist(rg_mbid, binding['artistMbid']):
            raise ValidationError('这个作品不属于已确认的艺人，请重新核对')
        with self.write_lock:
            return self.store.link_record_work(record_id, binding['artistMbid'], rg_mbid,
                                               expected_rg, record_artist, record_title)

    def work_unlink(self, record_id, expected_rg):
        with self.write_lock:
            return self.store.unlink_record_work(record_id, expected_rg)

    def _rg_credits_artist(self, rg_mbid, artist_mbid):
        """先查本地目录缓存；未命中或不含该艺人时，向来源核对 artist-credit。"""
        with self._known_lock:
            self._known = None  # 页缓存可能在集合构建后写入：核对前重建
        if self._rg_known(rg_mbid):
            for sub in ('catalog', 'release-groups'):
                for path in (self.cache_dir / sub).glob('*.json'):
                    data = self._read_json_file(path)
                    for w in (data or {}).get('works', []):
                        if isinstance(w, dict) and w.get('mbid') == rg_mbid:
                            return artist_mbid in (w.get('artistMbids') or [])
        try:
            data = self._single('rgdetail:' + rg_mbid,
                                lambda: self.mb.get('release-group/' + rg_mbid,
                                                    {'inc': 'artist-credits', 'fmt': 'json'}))
        except SourceNotFound:
            raise ValidationError('资料库中不存在这个作品编号') from None
        except (SourceUnavailable, BadSource) as exc:
            raise SourceUnavailableError(str(exc)) from None
        credit = [c for c in data.get('artist-credit', []) if isinstance(c, dict)]
        return any(isinstance(c.get('artist'), dict) and c['artist'].get('id') == artist_mbid for c in credit)

    def _rg_known(self, mbid):
        with self._known_lock:
            if self._known is None:
                known = set()
                for sub in ('catalog', 'release-groups'):
                    for path in (self.cache_dir / sub).glob('*.json'):
                        data = self._read_json_file(path)
                        for w in (data or {}).get('works', []):
                            if isinstance(w, dict) and isinstance(w.get('mbid'), str):
                                known.add(w['mbid'])
                self._known = known
            return mbid in self._known

    # ── 目录封面（CAA 组级代表图；不是用户持有的 CD 版封面）──
    def artwork(self, rg_mbid):
        if not is_uuid(rg_mbid): raise ValidationError('作品编号不正确')
        if not self._rg_known(rg_mbid): raise ValidationError('作品不在本地目录缓存中')
        art_dir = self.cache_dir / 'artwork'
        for ext, mime in (('jpg', 'image/jpeg'), ('png', 'image/png'), ('webp', 'image/webp')):
            path = art_dir / f'{rg_mbid}.{ext}'
            if path.is_file(): return {'data': path.read_bytes(), 'mime': mime}
        miss_path = art_dir / (rg_mbid + '.miss.json')
        miss = self._read_json_file(miss_path)
        if miss and self._fresh(miss, ARTWORK_MISS_TTL):
            return None  # 来源确认无图（1 天负缓存）
        key = 'art:' + rg_mbid
        if self._suppressed(key):
            raise SourceUnavailableError('封面服务暂时不可用，请稍后重试')
        try:
            with self._caa_lock:
                wait = 1.1 - (self._clock() - self._caa_last)
                if wait > 0: self._sleep(wait)
                self._caa_last = self._clock()
            listing = json.loads(self.covers.read(f'https://coverartarchive.org/release-group/{rg_mbid}',
                                                  1024 * 1024) or b'{}')
            images = listing.get('images', []) if isinstance(listing, dict) else []
            front = next((i for i in images if isinstance(i, dict) and i.get('front') and i.get('approved')), None)
            if not front:
                self._write_json_file(miss_path, {'ts': self._wall()})
                return None
            url = (front.get('thumbnails') or {}).get('500') \
                or (front.get('thumbnails') or {}).get('large') or front.get('image', '')
            if url.startswith('http://'): url = 'https://' + url[7:]
            data = self.covers.read(artwork_url(url), 2 * 1024 * 1024)
            ext, mime = _image_ext(data)
            art_dir.mkdir(parents=True, exist_ok=True)
            (art_dir / f'{rg_mbid}.{ext}').write_bytes(data)
            miss_path.unlink(missing_ok=True)
            return {'data': data, 'mime': mime}
        except ValidationError:
            self._mark_suppress(key)
            raise SourceUnavailableError('封面暂时读取失败，请稍后重试') from None

    # ── 后台预取 ──
    def _unbound_artists(self):
        with self.store.connect() as db:
            artists = {r['artist'] for r in self.store.rows(db, 'records') if r.get('artist')}
        return sorted(artists - set(self.store.artist_identities()))

    def enqueue_prewarm(self, artists=None):
        """把未绑定艺人排入后台预取队列；artists=None 表示按账本全量扫描。

        由路由在账本写入后（保存/导入/恢复）与服务启动时调用；同步扫描、
        异步取数，绝不阻塞请求。已在队列或处于重试等待期的艺人不重复入队。
        """
        if not self.prewarm_enabled: return 0
        names = list(artists) if artists is not None else self._unbound_artists()
        added = 0
        with self._prewarm_lock:
            now = self._clock()
            for name in names:
                if not isinstance(name, str) or not 1 <= len(name.strip()) <= 500: continue
                name = name.strip()
                if (name in self._prewarm_queued
                        or self._prewarm_next.get(name, 0) > now): continue
                self._prewarm_queued.add(name)
                self._prewarm_queue.append(name)
                added += 1
        if added: self._prewarm_wake.set()
        return added

    def start_prewarm(self):
        """启动后台工作线程（服务入口调用一次；测试直接驱动 _prewarm_step）。"""
        if self._prewarm_thread is not None: return
        self.enqueue_prewarm()  # 启动即补齐存量未绑定艺人
        thread = threading.Thread(target=self._prewarm_loop,
                                  name='artist-prewarm', daemon=True)
        self._prewarm_thread = thread
        thread.start()

    def _prewarm_loop(self):
        while True:
            self._prewarm_wake.wait(30)  # 周期唤醒：冷却结束或重试期到的项能被继续处理
            worked = False
            while self._prewarm_step():
                worked = True
                self._sleep(self.prewarm_gap)
            if not worked: self._prewarm_wake.clear()

    def _prewarm_step(self):
        """处理一个排队项（线程循环与测试共用）；返回是否处理了。
        来源限流冷却中不消耗队列（推迟到冷却后），失败按来源状态分级退避。"""
        with self._prewarm_lock:
            name = self._prewarm_queue.pop(0) if self._prewarm_queue else None
        if name is None: return False
        if self.mb.in_cooldown():
            with self._prewarm_lock:
                self._prewarm_queue.insert(0, name)  # 冷却中：原样放回，稍后再来
            return False
        try:
            self._prewarm_job(name)
            print(f'[艺人预取] {name}：完成', flush=True)
        except Exception as exc:
            print(f'[艺人预取] {name}：暂未完成（{exc}），稍后重试', flush=True)
        finally:
            # 限流刚发生（冷却中）说明来源正挤：短退避紧跟冷却结束；其余失败按常规退避
            retry = self.prewarm_retry_short if self.mb.in_cooldown() else self.prewarm_retry
            with self._prewarm_lock:
                self._prewarm_queued.discard(name)
                self._prewarm_next[name] = self._clock() + retry
        return True

    def _prewarm_job(self, name):
        if self._binding(name): return  # 用户已先确认（或上轮已绑定）
        result = self.resolve(name)     # 证据充分时这里会自动绑定
        print(f'[艺人预取] {name}：解析 → {result["status"]}（候选 {len(result.get("candidates") or [])}）', flush=True)
        if result['status'] == 'unavailable':
            raise SourceUnavailableError(result.get('error') or 'unavailable')
        if not self._binding(name): return  # ambiguous/not_found：等用户确认，不自动补资料
        self.profile(name)          # 资料缓存（fresh 即零网络）
        self._prefetch_catalog(name)  # 完整目录快照（已完整即零网络）

    def _prefetch_catalog(self, name):
        """按轮次把目录读到完整为止；已有完整快照时一次网络都不发。"""
        offset, round_id = 0, None
        for _ in range(64):  # 来源异常时由 roundError/409 终止，不无限追页
            page = self.catalog(name, offset, refresh=False, round_id=round_id)
            if page.get('status') == 'needs_resolution' or page.get('complete'): return
            round_id = page.get('roundId') or round_id
            offset = page.get('nextOffset')
            if offset is None: return
