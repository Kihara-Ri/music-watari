"""MusicBrainz JSON API 客户端：实例级统一节流，应用内所有 MusicBrainz 网络调用共用。

官方 API 规则（musicbrainz.org/doc/MusicBrainz_API）：每秒最多 1 次请求（这里取
1.1s 间隔）、显式 User-Agent、只访问 HTTPS musicbrainz.org 的 ws/2 接口、拒绝
跨主机跳转。429/503 按合法 Retry-After 记录冷却期；冷却期间直接返回可重试错误，
不让 HTTP 线程长眠。缓存命中与否由调用方决定，本客户端只节流真实请求。

测试可注入 opener / clock / sleep；不依赖真实睡眠与真实网络。
"""
import json
import re
import threading
import time
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, build_opener, HTTPRedirectHandler

API_HOST = 'musicbrainz.org'
MAX_BODY = 4 * 1024 * 1024
USER_AGENT = 'Diedu/2.4 (personal CD catalog; local instance)'
UUID_RE = re.compile(r'^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$')
MAX_COOLDOWN = 300  # Retry-After 上限（秒）；更长按 300 处理


class SourceUnavailable(Exception):
    """来源暂时不可用（网络失败 / 5xx / 超时）；可重试。"""


class SourceNotFound(SourceUnavailable):
    """来源确认实体不存在（HTTP 404）；与「暂时失败」分开，供身份失效等判定。"""


class RateLimited(SourceUnavailable):
    """命中 429/503 或处于冷却期；应等冷却结束后重试。"""


class BudgetExceeded(SourceUnavailable):
    """节流等待超出调用方剩余时间预算；未发起任何请求。"""


class BadSource(Exception):
    """来源返回了不可用的数据（地址不符 / 超限 / 非 JSON）。"""


def is_uuid(value):
    return isinstance(value, str) and bool(UUID_RE.match(value))


def lucene_quote(value):
    """Lucene 短语引号包裹 + 转义；保证专辑/艺人名里的标点不改变查询语义。"""
    return '"' + re.sub(r'([\\ +\-!():^\[\]{}~*?|&/])', r'\\\1', str(value)) + '"'


class _SameHostRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if urlsplit(newurl).hostname != urlsplit(req.full_url).hostname or urlsplit(newurl).scheme != 'https':
            raise SourceUnavailable('资料库返回了不支持的跳转')
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class MusicBrainzClient:
    def __init__(self, opener=None, clock=time.monotonic, sleep=time.sleep,
                 interval=1.1, timeout=10.0):
        self._lock = threading.Lock()
        self._last = float('-inf')
        self._cooldown_until = float('-inf')
        self._clock = clock
        self._sleep = sleep
        self.interval = interval
        self.timeout = timeout
        self._opener = opener or build_opener(_SameHostRedirect())

    def in_cooldown(self):
        with self._lock:
            return self._cooldown_until > self._clock()

    def get(self, path, params, budget=None):
        """GET /ws/2/<path>?<params> → 解析后的 JSON。budget 为剩余秒数（可选）。"""
        url = f'https://{API_HOST}/ws/2/' + str(path).strip('/') + '?' + urlencode(params)
        return self.get_url(url, budget=budget)

    def get_url(self, url, budget=None):
        """完整 URL 版本（covers 迁移用）；仅接受本 API 的 ws/2 地址。"""
        p = urlsplit(url)
        if (p.scheme != 'https' or p.hostname != API_HOST or p.username or p.password
                or p.port not in (None, 443) or not p.path.startswith('/ws/2/')):
            raise BadSource('不受支持的资料库地址')
        with self._lock:
            now = self._clock()
            wait = self._cooldown_until - now
            if wait > 0:
                raise RateLimited('资料库限流冷却中，请稍后重试')
            wait = self.interval - (now - self._last)
            if wait > 0:
                if budget is not None and wait >= budget:
                    raise BudgetExceeded('资料核对时间超出预算')
                self._sleep(wait)
            self._last = self._clock()
        try:
            request = Request(url, headers={'User-Agent': USER_AGENT, 'Accept': 'application/json'})
            with self._opener.open(request, timeout=self.timeout) as response:
                body = response.read(MAX_BODY + 1)
        except HTTPError as exc:
            if exc.code == 404:
                raise SourceNotFound('资料库中没有这一条目') from None
            if exc.code in (429, 503):
                retry = self._retry_after(exc)
                with self._lock:
                    self._cooldown_until = self._clock() + retry
                raise RateLimited(f'资料库限流，请约 {min(retry, 60):.0f} 秒后重试') from None
            raise SourceUnavailable(f'资料库返回 HTTP {exc.code}') from None
        except SourceUnavailable:
            raise
        except Exception as exc:
            raise SourceUnavailable('暂时无法连接资料库') from exc
        if len(body) > MAX_BODY:
            raise BadSource('资料库响应过大')
        try:
            data = json.loads(body)
        except (ValueError, UnicodeError):
            raise BadSource('资料库返回了无效 JSON') from None
        if not isinstance(data, (dict, list)):
            raise BadSource('资料库返回了无效 JSON')
        return data

    @staticmethod
    def _retry_after(exc):
        value = exc.headers.get('Retry-After') if exc.headers else None
        try:
            return max(1, min(int(float(value)), MAX_COOLDOWN))
        except (TypeError, ValueError):
            return 5
