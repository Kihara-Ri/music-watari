"""API 路由表。新增接口 = 写一个处理函数 + 在表里加一行。

GET 处理函数签名 fn(h, svc)；POST 为 fn(h, svc, body)。
h 提供 send()/query；svc 是注入的服务集合（见 context.Services）。
"""
import hashlib
import base64
import mimetypes
import re
import threading
from urllib.parse import parse_qs, urlsplit

from domain import ValidationError
from storage import SCHEMA
from . import export_csv
from .artists import SourceUnavailableError
from .version import uptime, version

# 所有改状态的 store 调用共用一把锁，串行化并发写
WRITE_LOCK = threading.Lock()


def query(h):
    """URL 查询串 → 首值字典。浏览器 fetch 总是百分号编码；裸 UTF-8（如 curl 直连）按原字节recover。"""
    out = {}
    for key, values in parse_qs(urlsplit(h.path).query).items():
        fixed = []
        for v in values:
            try:
                fixed.append(v.encode('latin-1').decode('utf-8'))
            except (UnicodeEncodeError, UnicodeDecodeError):
                fixed.append(v)
        out[key] = fixed[0]
    return out


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


def api_cover(h, svc):
    """封面文件 /api/cover/<16位内容哈希>.<jpg|png|webp>；内容寻址 → 可 immutable 长缓存。"""
    name = urlsplit(h.path).path.split('/')[-1]
    if not re.fullmatch(r'[0-9a-f]{16}\.(jpg|png|webp)', name):
        return h.send({'error': '封面不存在'}, 404)
    path = svc.store.covers_dir / name
    if not path.is_file(): return h.send({'error': '封面不存在'}, 404)
    mime = {'jpg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp'}[name.rsplit('.', 1)[1]]
    return h.send(path.read_bytes(), mime=mime, cache='private, max-age=31536000, immutable')


def api_backup(h, svc):
    h.send(svc.store.backup(), filename='album-ledger-backup.json')


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


# ── 艺人资料与作品目录：外网请求不持有写锁，storage 写入由服务内部短锁串行 ──
def artists(svc):
    if svc.artists is None: raise ValidationError('艺人资料服务未启动，请重启碟渡')
    return svc.artists


def prewarm(svc):
    """账本写入后台预取新艺人：同步扫描入队、异步取数，失败静默（不影响写请求）。"""
    if svc.artists is None: return
    try:
        svc.artists.enqueue_prewarm()
    except Exception:
        pass


def _unavailable(h, exc):
    h.send({'status': 'unavailable', 'error': str(exc)}, 503)


def api_artists_resolve(h, svc, body):
    try:
        h.send(artists(svc).resolve(body.get('artist', ''), body.get('searchName'),
                                    force=bool(body.get('force'))))
    except SourceUnavailableError as exc:
        _unavailable(h, exc)


def api_artists_bind(h, svc, body):
    try:
        binding = artists(svc).bind(body.get('artist', ''), body.get('artistMbid'),
                                    body.get('expectedArtistMbid'))
        h.send({'ok': True, 'binding': binding})
    except SourceUnavailableError as exc:
        _unavailable(h, exc)


def api_artists_profile(h, svc):
    q = query(h)
    try:
        h.send(artists(svc).profile(q.get('artist', ''), refresh=q.get('refresh') == '1'))
    except SourceUnavailableError as exc:
        h.send({'artist': q.get('artist', ''), 'status': 'unavailable', 'error': str(exc)}, 503)


def api_artists_catalog(h, svc):
    q = query(h)
    try:
        h.send(artists(svc).catalog(q.get('artist', ''), q.get('offset', 0),
                                    refresh=q.get('refresh') == '1', round_id=q.get('roundId')))
    except SourceUnavailableError as exc:
        h.send({'status': 'unavailable', 'error': str(exc)}, 503)


def api_artists_work_link(h, svc, body):
    try:
        link = artists(svc).work_link(body.get('artist', ''), body.get('recordId'),
                                      body.get('releaseGroupMbid'), body.get('expectedReleaseGroupMbid'),
                                      body.get('recordArtist', ''), body.get('recordTitle', ''))
        h.send({'ok': True, 'link': link})
    except SourceUnavailableError as exc:
        _unavailable(h, exc)


def api_artists_work_unlink(h, svc, body):
    h.send({'ok': True, **artists(svc).work_unlink(body.get('recordId'),
                                                   body.get('expectedReleaseGroupMbid'))})


def api_artists_artwork(h, svc):
    """作品缩略封面：无图 404、临时失败 503；只有本地目录缓存里出现过的作品 ID 可取。"""
    try:
        result = artists(svc).artwork(urlsplit(h.path).path.split('/')[-1])
    except SourceUnavailableError as exc:
        return h.send({'error': str(exc)}, 503)
    if result is None: return h.send({'error': '暂无封面'}, 404)
    h.send(result['data'], mime=result['mime'], cache='private, max-age=2592000')


# ── POST：账本写操作（全部走 WRITE_LOCK）────────────────────────────
def api_records(h, svc, body):
    h.send(svc.store.save(body))
    prewarm(svc)
def api_bulk(h, svc, body):
    h.send(svc.store.bulk(body))
    prewarm(svc)
def api_sales(h, svc, body): h.send(svc.store.sell(body))
def api_sale_action(h, svc, body): h.send(svc.store.sale_action(body))
def api_sale_update(h, svc, body): h.send(svc.store.update_sale(body))
def api_shipments(h, svc, body): h.send(svc.store.ship(body))
def api_shipment_action(h, svc, body): h.send(svc.store.shipment_action(body))
def api_shipment_update(h, svc, body): h.send(svc.store.update_shipment(body))
def api_import(h, svc, body):
    h.send(svc.store.import_data(body.get('albums')))
    prewarm(svc)
def api_restore(h, svc, body):
    h.send(svc.store.restore_backup(body))
    prewarm(svc)
def api_modules(h, svc, body): h.send(svc.store.set_modules(body.get('enabled')))


def vision(svc):
    if svc.vision is None: raise ValidationError('视觉服务未启动，请重启碟渡')
    return svc.vision


def api_vision(h, svc): h.send(vision(svc).public_config())
def api_vision_providers(h, svc): h.send(vision(svc).providers())
def api_vision_codex_login(h, svc, body): h.send(vision(svc).start_login())
def api_vision_codex_callback(h, svc, body): h.send(vision(svc).complete_login(body.get('url','')))
def api_vision_codex_logout(h, svc, body): h.send(vision(svc).logout())
def api_release(h, svc): h.send({'releaseInfo':vision(svc).release_details(query(h).get('id'))})
def api_vision_config(h, svc, body): h.send(vision(svc).configure(body))
def api_imports(h, svc): h.send({'drafts':svc.store.list_imports()})
def api_import_draft(h, svc): h.send(svc.store.read_import(query(h).get('id')))
def api_import_create(h, svc, body): h.send(svc.store.create_import(body.get('common',{})))
def api_import_upload(h, svc, body): h.send(svc.store.upload_import_photo(body.get('id'),body.get('name',''),body.get('data')))
def api_import_update(h, svc, body): h.send(svc.store.update_import(body))
def api_import_start(h, svc, body): h.send(vision(svc).start(body))
def api_import_commit(h, svc, body):
    h.send(svc.store.commit_import(body))
    prewarm(svc)
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
    '/api/artists/profile': api_artists_profile,
    '/api/artists/catalog': api_artists_catalog,
    '/api/export': api_export,
    '/api/vision': api_vision,
    '/api/vision/providers': api_vision_providers,
    '/api/vision/release': api_release,
    '/api/imports': api_imports,
    '/api/imports/draft': api_import_draft,
}
PUBLIC_GET = {  # 免登录（监控与部署探测）
    '/api/health',
}
GET_PREFIX = {  # 带路径参数的接口
    '/api/photo/': api_photo,
    '/api/cover/': api_cover,
    '/api/import-photo/': api_import_photo,
    '/api/artists/artwork/': api_artists_artwork,
}
POST = {
    # path: (处理函数, 需要登录, 需要 WRITE_LOCK)
    '/api/login': (api_login, False, False),
    '/api/logout': (api_logout, True, False),
    '/api/password': (api_password, True, True),
    '/api/covers/search': (api_covers_search, True, False),
    '/api/covers/download': (api_covers_download, True, False),
    '/api/artists/resolve': (api_artists_resolve, True, False),
    '/api/artists/bind': (api_artists_bind, True, False),
    '/api/artists/work-link': (api_artists_work_link, True, False),
    '/api/artists/work-unlink': (api_artists_work_unlink, True, False),
    '/api/records': (api_records, True, True),
    '/api/bulk': (api_bulk, True, True),
    '/api/sales': (api_sales, True, True),
    '/api/sale-action': (api_sale_action, True, True),
    '/api/sale-update': (api_sale_update, True, True),
    '/api/shipments': (api_shipments, True, True),
    '/api/shipment-action': (api_shipment_action, True, True),
    '/api/shipment-update': (api_shipment_update, True, True),
    '/api/import-preview': (api_import_preview, True, True),
    '/api/import': (api_import, True, True),
    '/api/restore': (api_restore, True, True),
    '/api/modules': (api_modules, True, True),
    '/api/vision/config': (api_vision_config, True, False),
    '/api/vision/codex/login': (api_vision_codex_login, True, False),
    '/api/vision/codex/callback': (api_vision_codex_callback, True, False),
    '/api/vision/codex/logout': (api_vision_codex_logout, True, False),
    '/api/recognize': (api_recognize, True, False),
    '/api/imports/create': (api_import_create, True, False),
    '/api/imports/upload': (api_import_upload, True, False),
    '/api/imports/update': (api_import_update, True, False),
    '/api/imports/start': (api_import_start, True, False),
    '/api/imports/commit': (api_import_commit, True, True),
    '/api/imports/delete': (api_import_delete, True, False),
}

# 允许跨站（外部页面）调用的写接口；当前为空，保留豁免管线供未来令牌鉴权回调使用
CROSS_SITE_POST: set = set()


def resolve_get(path):
    if path in GET: return GET[path]
    for prefix, fn in GET_PREFIX.items():
        if path.startswith(prefix): return fn
    return None


def resolve_post(path):
    return POST.get(path)
