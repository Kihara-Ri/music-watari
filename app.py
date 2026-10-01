#!/usr/bin/env python3
"""碟渡入口：命令行参数、服务组装、启动服务。

HTTP 细节在 server/ 包；业务逻辑在根目录模块
（domain / storage / covers / rates / security / backups）。

    python3 app.py [--host 0.0.0.0] [--port 8765] [--data-dir DIR] [--public-origin https://…]

所有参数均可用环境变量 HOST / PORT / DATA_DIR / PUBLIC_ORIGIN 提供（Docker 用）。
"""
import argparse, getpass, json, os, signal, threading
from pathlib import Path
from urllib.parse import urlsplit
from http.server import ThreadingHTTPServer

from backups import Backups
from covers import CoverService
from rates import RateService
from security import Auth
from server import Services, make_handler
from server.version import version
from server.recognition import VisionService
from storage import Store

ROOT = Path(__file__).resolve().parent


def build(data_dir, public_origin=None):
    """从数据目录组装全部服务；无全局单例，测试可用临时目录构建。"""
    data = Path(data_dir)
    rates = RateService(data / 'rates.sqlite3')
    store = Store(data / 'albums.sqlite3', rates)
    covers = CoverService(data / 'cover-cache.sqlite3')
    return Services(store=store,
                    auth=Auth(data / 'auth.sqlite3'),
                    covers=covers, vision=VisionService(store, covers),
                    rates=rates,
                    public_origin=public_origin)


def seed_from_json(store, source=None):
    """一次性导入 albums.json 采购记录（按 meta 标记幂等；文件放在数据目录）。

    框架仓库不含任何数据；把自己的 albums.json 放进数据目录即可在首次启动导入。
    """
    if source is None:
        source = Path(store.path).parent / 'albums.json'
    with store.connect() as db:
        if db.execute("SELECT 1 FROM meta WHERE key='seeded'").fetchone(): return
    if not source.exists(): return
    store.import_data(json.loads(source.read_text()))
    with store.connect() as db: db.execute("INSERT OR REPLACE INTO meta VALUES('seeded','true')")


def main():
    env = os.environ
    p = argparse.ArgumentParser()
    p.add_argument('--host', default=env.get('HOST', '127.0.0.1'))
    p.add_argument('--port', type=int, default=int(env.get('PORT', '8765')))
    p.add_argument('--data-dir', default=env.get('DATA_DIR', str(ROOT / 'data')))
    p.add_argument('--public-origin', default=env.get('PUBLIC_ORIGIN'))
    p.add_argument('--no-seed', action='store_true')
    p.add_argument('--set-password', action='store_true')
    args = p.parse_args()
    os.umask(0o077)
    Path(args.data_dir).mkdir(parents=True, exist_ok=True)
    if args.set_password:
        auth = Auth(Path(args.data_dir) / 'auth.sqlite3')
        password = getpass.getpass('设置登录密码（至少12个字符）：')
        if password != getpass.getpass('再次输入：'): raise SystemExit('两次密码不一致')
        auth.set_password(password); print('密码已设置'); return
    if args.public_origin:
        u = urlsplit(args.public_origin)
        if u.scheme != 'https' or not u.netloc or u.path or u.query or u.fragment:
            raise SystemExit('--public-origin 必须是 HTTPS 根地址')
    svc = build(args.data_dir, args.public_origin)
    if args.public_origin and not svc.auth.configured():
        raise SystemExit('请先使用 --set-password 设置密码')
    if not svc.auth.configured(): svc.auth = None  # 本机模式不启用登录
    if not args.no_seed: seed_from_json(svc.store)
    svc.backups = Backups(svc.store.path); svc.backups.start()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(svc))
    print(f'碟渡已启动：http://{args.host}:{args.port}（版本 {version()}）', flush=True)

    # 优雅停机：SIGTERM/SIGINT → 收完在途请求再退出（systemd / docker stop 不硬切）
    def stop(_signum, _frame):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        server.serve_forever()
    finally:
        server.server_close()
        svc.vision.close()
        print('碟渡已停止', flush=True)


if __name__ == '__main__':
    main()
