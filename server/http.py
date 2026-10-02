"""请求管线：安全响应头、Host/Origin 校验、登录检查与路由分发。

路由本身在 routes.py 的表里；本文件不出现任何具体接口。
"""
import gzip
import json
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlsplit

from domain import ValidationError
from . import routes, static_files

CSP = ("default-src 'self'; img-src 'self' data: https://*.mzstatic.com https://archive.org "
       "https://*.archive.org https://coverartarchive.org; style-src 'self'; "
       "script-src 'self' 'unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; "
       "frame-ancestors 'none'; base-uri 'none'")
MAX_BODY = 50 * 1024 * 1024
TIMEOUT = 60  # 单次 socket 读超时（秒）：慢客户端不占住线程
COMPRESSIBLE = ('application/json', 'text/', 'application/javascript', 'image/svg+xml')


def make_handler(svc):
    class Handler(BaseHTTPRequestHandler):
        timeout = TIMEOUT
        protocol_version = 'HTTP/1.1'  # Content-Length 全程齐备，keep-alive 省去每请求重握手

        # ── 响应 ──
        def send(self, data, status=200, mime='application/json; charset=utf-8', filename=None,
                 headers=None, cache=None, etag=None):
            if not isinstance(data, bytes):
                data = json.dumps(data, ensure_ascii=False).encode() if 'json' in mime else str(data).encode()
            # 文本类大响应按客户端能力 gzip：state JSON 与构建产物是打开网页的主要流量
            if (len(data) >= 1024 and 'gzip' in self.headers.get('Accept-Encoding', '')
                    and mime.startswith(COMPRESSIBLE)):
                data = gzip.compress(data, 6)
                encoding = 'gzip'
            else:
                encoding = ''
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Cache-Control', cache or 'no-store')
            if etag: self.send_header('ETag', etag)
            if encoding:
                self.send_header('Content-Encoding', 'gzip')
                self.send_header('Vary', 'Accept-Encoding')
            self.send_header('Content-Security-Policy', CSP)
            if filename: self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            for k, v in (headers or {}).items(): self.send_header(k, v)
            self.end_headers(); self.wfile.write(data)

        def not_modified(self, etag, cache='no-store'):
            self.send_response(304)
            self.send_header('ETag', etag)
            self.send_header('Cache-Control', cache)
            self.end_headers()

        # ── 请求守卫 ──
        def trusted(self, allow_cross_site=False):
            """只认本机回环地址与（可选的）公网源；挡跨站脚本伪造与错误 Host。

            allow_cross_site 供令牌鉴权的外部回调（如 RYM 书签绑定）豁免 Origin 检查。
            回环主机（127.0.0.1/localhost/::1）允许任意端口——Docker 端口映射时浏览器
            Host 是宿主机端口、容器内是另一端口。跨站防护不依赖这一条：Origin 必须
            命中白名单或与当前 Host 完全一致，Sec-Fetch-Site 挡跨站。
            """
            host = self.headers.get('Host', '')
            port = self.server.server_port
            origins = {f'http://127.0.0.1:{port}', f'http://localhost:{port}'}
            if svc.public_origin: origins.add(svc.public_origin)
            hostname = (urlsplit(f'//{host}').hostname or '').lower()
            loopback = hostname in ('127.0.0.1', 'localhost', '::1')
            allowed = {urlsplit(o).netloc for o in origins}
            if loopback: allowed.add(host)
            if host not in allowed:
                self.send({'error': '访问地址未配置'}, 403); return False
            if not allow_cross_site:
                origin = self.headers.get('Origin')
                if origin:
                    onetloc = urlsplit(origin).netloc
                    if onetloc not in allowed and not (loopback and onetloc == host):
                        self.send({'error': '不允许跨站请求'}, 403); return False
                if self.headers.get('Sec-Fetch-Site') == 'cross-site':
                    self.send({'error': '不允许跨站请求'}, 403); return False
            return True

        def logged_in(self):
            return not svc.auth or svc.auth.valid(self.headers.get('Cookie'))

        def authorized(self):
            if not self.logged_in():
                self.send({'error': '请登录后继续操作'}, 401); return False
            return True

        def redirect_login(self):
            # 页面与静态资源未登录走 302，浏览器直接落到登录页；API 走 authorized() 的 401
            self.send_response(302)
            self.send_header('Location', '/login')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Content-Length', '0')
            self.end_headers()

        def session_cookie(self, token, logout=False):
            # 服务端会话 30 天滑动续期（security.valid）才是真正的门；cookie 寿命给足
            # 余量，避免仍在使用的设备因 cookie 先到期而被迫重新登录。
            return ('album_session=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age='
                    + ('0' if logout else str(180 * 86400))
                    + ('; Secure' if svc.public_origin else ''))

        # ── 分发 ──
        def do_GET(self):
            if not self.trusted(): return
            path = urlsplit(self.path).path
            if path.startswith('/api/'):
                if path not in routes.PUBLIC_GET and not self.authorized(): return
                fn = routes.resolve_get(path)
                if fn: return fn(self, svc)
                return self.send({'error': '接口不存在'}, 404)
            # 服务端登录门：未登录只放行登录页及其依赖（static_files.PUBLIC）
            if not self.logged_in() and path not in static_files.PUBLIC:
                return self.redirect_login()
            return static_files.serve(self, path)

        def do_POST(self):
            # 先读完整请求体再分发：keep-alive 连接上未读的 body 字节会被误解析为下一个请求。
            # 无长度/超限的请求无法确定边界，读完响应即断开连接。
            try:
                length = int(self.headers.get('Content-Length', 0))
            except ValueError:
                length = -1
            raw = self.rfile.read(length) if 0 < length <= MAX_BODY else None
            if raw is None: self.close_connection = True
            if not self.trusted(allow_cross_site=urlsplit(self.path).path in routes.CROSS_SITE_POST): return
            ctype = self.headers.get('Content-Type', '').split(';')[0]
            # text/plain 供跨站书签的 no-cors fetch（body 仍是 JSON）；其余请求一律 application/json
            if ctype not in ('application/json', 'text/plain'):
                return self.send({'error': '请使用 JSON 请求'}, 415)
            try:
                if raw is None: raise ValidationError('请求内容为空或超过 50 MB')
                body = json.loads(raw)
                if not isinstance(body, dict): raise ValidationError('请求格式不正确')
                fn, needs_auth, needs_lock = routes.resolve_post(urlsplit(self.path).path)
                if not fn: return self.send({'error': '接口不存在'}, 404)
                if needs_auth and not self.authorized(): return
                if needs_lock:
                    with routes.WRITE_LOCK: fn(self, svc, body)
                else: fn(self, svc, body)
            except (ValidationError, json.JSONDecodeError, ValueError, TypeError, KeyError) as e:
                self.send({'error': str(e)}, 400)
            except Exception:
                import traceback; traceback.print_exc()
                self.send({'error': '保存失败，请重试；输入内容仍保留'}, 500)

        def log_message(self, fmt, *args):
            # 只记录 4xx/5xx；正常请求静默
            if args and str(args[1] if len(args) > 1 else '').startswith(('4', '5')):
                super().log_message(fmt, *args)
    return Handler
