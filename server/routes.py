"""API 路由表。新增接口 = 写一个处理函数 + 在表里加一行。

GET 处理函数签名 fn(h, svc)；POST 为 fn(h, svc, body)。
h 提供 send()/query；svc 是注入的服务集合（见 context.Services）。
"""
import hashlib
import base64
import mimetypes
import threading
from urllib.parse import parse_qs, urlsplit

from domain import ValidationError
from storage import SCHEMA
from . import export_csv
from .version import uptime, version

# 所有改状态的 store 调用共用一把锁，串行化并发写
WRITE_LOCK = threading.Lock()


def query(h):
    """URL 查询串 → 首值字典。"""
    return {k: v[0] for k, v in parse_qs(urlsplit(h.path).query).items()}


# ── GET ──────────────────────────────────────────────────────────────
def api_health(h, svc):
    """存活与版本探测：部署脚本和外部监控用，免登录，只暴露运行状态不暴露数据。"""
    try:
        with svc.store.connect() as db:
            db.execute('SELECT 1').fetchone()
    except Exception:
        return h.send({'ok': False, 'version': version(), 'error': 'database unavailable'}, 503)
    h.send({'ok': True, 'version': version(), 'schema': SCHEMA, 'uptime': uptime()})


def api_state(h, svc):
    state = svc.store.state()
    state['service'] = {'login': bool(svc.auth), 'version': version(),
                        'backup': svc.backups.status() if svc.backups else {}}
    h.send(state)


def api_rate(h, svc):
    d = query(h).get('date', '')
    h.send({'date': d, 'rate': svc.rates.get(d) if svc.rates else None})


def api_photo(h, svc):
    """实物照片 /api/photo/<32位hex记录id>/<序号>；序号按文件名排序取第一个扩展名匹配。"""
    parts = urlsplit(h.path).path.split('/')
    ok = (len(parts) == 5 and len(parts[3]) == 32
          and all(c in '0123456789abcdef' for c in parts[3]) and parts[4].isdigit())
    folder = svc.store.photos_dir / parts[3] if ok else None
    files = sorted(folder.glob(parts[4] + '.*')) if folder and folder.exists() else []
    if not files: return h.send({'error': '照片不存在'}, 404)
    return h.send(files[0].read_bytes(), mime=mimetypes.guess_type(files[0])[0] or 'image/jpeg')


def api_backup(h, svc):
    h.send(svc.store.backup(), filename='album-ledger-backup.json')


def api_artist_links(h, svc):
    h.send({'links': svc.store.artist_links(), 'token': svc.store.rym_token()})


def api_artist_bind(h, svc, body):
    """书签从 RYM 艺人页跨站回传：无会话，凭 meta 里的令牌鉴权。"""
    h.send(svc.store.bind_artist(body.get('token'), body.get('title', ''), body.get('url', '')))


def api_export(h, svc):
    if query(h).get('scope') == 'sales':
        return h.send(export_csv.sales_csv(svc.store.state()), mime='text/csv; charset=utf-8', filename='sales.csv')
    return h.send(export_csv.albums_csv(svc.store.state()), mime='text/csv; charset=utf-8', filename='albums.csv')


# ── POST：登录与会话 ──────────────────────────────────────────────────
def api_login(h, svc, body):
    if not svc.auth: return h.send({'ok': True})
    password = body.get('password', '')
    if not isinstance(password, str) or len(password) > 1024: raise ValidationError('密码格式不正确')
    token = svc.auth.login(password, h.client_address[0])
    h.send({'ok': True}, headers={'Set-Cookie': h.session_cookie(token)})


def api_logout(h, svc, body):
    if svc.auth: svc.auth.logout(h.headers.get('Cookie'))
    h.send({'ok': True}, headers={'Set-Cookie': h.session_cookie('', True)})


def api_password(h, svc, body):
    """改密：验证当前密码后换新；除当前会话外其他设备全部退出。"""
    current, new = body.get('current', ''), body.get('next', '')
    if not isinstance(current, str) or not isinstance(new, str) or len(current) > 1024 or len(new) > 1024:
        raise ValidationError('密码格式不正确')
    keep = svc.auth.token(h.headers.get('Cookie'))
    keep_hash = hashlib.sha256(keep.encode()).hexdigest() if keep else None
    svc.auth.change_password(current, new, keep_hash)
    h.send({'ok': True})


# ── POST：封面（只读缓存，不进写锁）─────────────────────────────────
def api_covers_search(h, svc, body):
    h.send(svc.covers.search(body.get('title', ''), body.get('artist', ''), body.get('country', 'AUTO')))


def api_covers_download(h, svc, body):
    h.send(svc.covers.download(body.get('token')))


# ── POST：账本写操作（全部走 WRITE_LOCK）────────────────────────────
def api_records(h, svc, body): h.send(svc.store.save(body))
def api_bulk(h, svc, body): h.send(svc.store.bulk(body))
def api_sales(h, svc, body): h.send(svc.store.sell(body))
def api_sale_action(h, svc, body): h.send(svc.store.sale_action(body))
def api_shipments(h, svc, body): h.send(svc.store.ship(body))
def api_shipment_action(h, svc, body): h.send(svc.store.shipment_action(body))
def api_shipment_update(h, svc, body): h.send(svc.store.update_shipment(body))
def api_import(h, svc, body): h.send(svc.store.import_data(body.get('albums')))
def api_restore(h, svc, body): h.send(svc.store.restore_backup(body))
def api_modules(h, svc, body): h.send(svc.store.set_modules(body.get('enabled')))


def vision(svc):
    if svc.vision is None: raise ValidationError('视觉服务未启动，请重启碟渡')
    return svc.vision


def api_vision(h, svc): h.send(vision(svc).public_config())
def api_release(h, svc): h.send({'releaseInfo':vision(svc).release_details(query(h).get('id'))})
def api_vision_config(h, svc, body): h.send(vision(svc).configure(body))
def api_imports(h, svc): h.send({'drafts':svc.store.list_imports()})
def api_import_draft(h, svc): h.send(svc.store.read_import(query(h).get('id')))
def api_import_create(h, svc, body): h.send(svc.store.create_import(body.get('common',{})))
def api_import_upload(h, svc, body): h.send(svc.store.upload_import_photo(body.get('id'),body.get('name',''),body.get('data')))
def api_import_update(h, svc, body): h.send(svc.store.update_import(body))
def api_import_start(h, svc, body): h.send(vision(svc).start(body))
def api_import_commit(h, svc, body): h.send(svc.store.commit_import(body))
def api_import_delete(h, svc, body): h.send(svc.store.delete_import(body.get('id')))


def api_import_photo(h, svc):
    parts = urlsplit(h.path).path.split('/')
    if len(parts)!=5: raise ValidationError('照片地址不正确')
    path = svc.store.import_photo(parts[3],parts[4])
    h.send(path.read_bytes(),mime=mimetypes.guess_type(path.name)[0] or 'image/jpeg')


def api_recognize(h, svc, body):
    rid = body.get('recordId')
    if rid:
        with svc.store.connect() as db: svc.store.get(db,'records',rid)
    else: rid = '0'*32
    plan = svc.store.prepare_photos(rid,body.get('photos'))
    mimes = {'.jpg':'jpeg','.png':'png','.webp':'webp'}
    images = ['data:image/'+mimes[ext]+';base64,'+base64.b64encode(raw).decode() for ext,raw in plan]
    h.send(vision(svc).recognize(images))


def api_import_preview(h, svc, body):
    p = svc.store.import_preview(body.get('albums'))
    h.send({'count': len(p['records']), 'skipped': p['skipped'], 'errors': p['errors'],
            'titles': [r['title'] for r in p['records'][:8]]})


# ── 路由表 ───────────────────────────────────────────────────────────
GET = {
    '/api/health': api_health,
    '/api/state': api_state,
    '/api/rate': api_rate,
    '/api/backup': api_backup,
    '/api/artist-links': api_artist_links,
    '/api/export': api_export,
    '/api/vision': api_vision,
    '/api/vision/release': api_release,
    '/api/imports': api_imports,
    '/api/imports/draft': api_import_draft,
}
PUBLIC_GET = {  # 免登录（监控与部署探测）
    '/api/health',
}
GET_PREFIX = {  # 带路径参数的接口
    '/api/photo/': api_photo,
    '/api/import-photo/': api_import_photo,
}
POST = {
    # path: (处理函数, 需要登录, 需要 WRITE_LOCK)
    '/api/login': (api_login, False, False),
    '/api/logout': (api_logout, True, False),
    '/api/password': (api_password, True, True),
    '/api/covers/search': (api_covers_search, True, False),
    '/api/covers/download': (api_covers_download, True, False),
    '/api/records': (api_records, True, True),
    '/api/bulk': (api_bulk, True, True),
    '/api/sales': (api_sales, True, True),
    '/api/sale-action': (api_sale_action, True, True),
    '/api/shipments': (api_shipments, True, True),
    '/api/shipment-action': (api_shipment_action, True, True),
    '/api/shipment-update': (api_shipment_update, True, True),
    '/api/import-preview': (api_import_preview, True, True),
    '/api/import': (api_import, True, True),
    '/api/restore': (api_restore, True, True),
    '/api/modules': (api_modules, True, True),
    '/api/vision/config': (api_vision_config, True, False),
    '/api/recognize': (api_recognize, True, False),
    '/api/imports/create': (api_import_create, True, False),
    '/api/imports/upload': (api_import_upload, True, False),
    '/api/imports/update': (api_import_update, True, False),
    '/api/imports/start': (api_import_start, True, False),
    '/api/imports/commit': (api_import_commit, True, True),
    '/api/imports/delete': (api_import_delete, True, False),
    # 书签回传绑定：来自 rateyourmusic.com 的跨站请求，凭令牌鉴权（见 api_artist_bind）
    '/api/artist-bind': (api_artist_bind, False, True),
}

# 允许跨站（书签/外部页面）调用的写接口；trusted() 对这些路径豁免 Origin 检查
CROSS_SITE_POST = {'/api/artist-bind'}


def resolve_get(path):
    if path in GET: return GET[path]
    for prefix, fn in GET_PREFIX.items():
        if path.startswith(prefix): return fn
    return None


def resolve_post(path):
    return POST.get(path)
