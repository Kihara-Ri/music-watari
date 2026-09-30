"""静态文件服务：static/ 目录下的真实文件均可访问，防路径穿越。

前端新增 js/styles 文件不需要改后端；/ 与 /login 是仅有的两个页面别名。
"""
import mimetypes
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATIC = ROOT / 'static'
ALIASES = {'/': 'index.html', '/login': 'login.html'}


def serve(h, path):
    rel = ALIASES.get(path, path.lstrip('/'))
    target = (STATIC / rel).resolve()
    if STATIC not in target.parents or not target.is_file():
        return h.send({'error': '页面不存在'}, 404)
    h.send(target.read_bytes(), mime=mimetypes.guess_type(target)[0] or 'application/octet-stream')
