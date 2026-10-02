"""静态文件服务：static/ 目录下的真实文件均可访问，防路径穿越。

前端新增 js/styles 文件不需要改后端；/ 与 /login 是仅有的两个页面别名。
启用登录后由 http.py 在分发前设服务端登录门：PUBLIC 之外的一切路径未登录
一律 302 到 /login——登录页本身、它的渲染依赖和 PWA 壳元数据（均不含数据）
保持可取，应用本体（页面、应用 JS、vendor）只有登录设备能拿到。
"""
import mimetypes
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / 'static'
ALIASES = {'/': 'index.html', '/login': 'login.html'}

# 免登录的请求路径（login.html 引用的资源变化时须同步维护这份名单）
PUBLIC = frozenset({
    '/login', '/login.js', '/theme.js', '/assets/index.css', '/favicon.svg',
    '/manifest.webmanifest', '/sw.js', '/offline.html',
    '/icon-192.png', '/icon-512.png', '/icon-192-maskable.png', '/icon-512-maskable.png',
})


def serve(h, path):
    rel = ALIASES.get(path, path.lstrip('/'))
    target = (STATIC / rel).resolve()
    if STATIC not in target.parents or not target.is_file():
        return h.send({'error': '页面不存在'}, 404)
    mime = mimetypes.guess_type(target)[0] or 'application/octet-stream'
    if rel.startswith('assets/'):
        # 构建产物（几十万字节）：文件名稳定不带哈希 → ETag 协商缓存，未变更即 304 免重传；
        # 改版重新构建后 mtime 变化自动失效，无需手动清缓存。
        etag = f'"{target.stat().st_mtime_ns:x}-{target.stat().st_size:x}"'
        if h.headers.get('If-None-Match') == etag:
            return h.not_modified(etag, 'no-cache')
        return h.send(target.read_bytes(), mime=mime, cache='no-cache', etag=etag)
    # 壳文件（页面/图标/sw/theme）极小且可能原地替换，保持 no-store 立即生效
    h.send(target.read_bytes(), mime=mime)
