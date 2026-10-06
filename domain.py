"""Decimal accounting and input validation, independent of storage and HTTP.

Cost model: JPY purchases are valued at the ECB reference rate for the buy
date (auto-fetched, cached); an explicit actual-CNY amount still wins.
A record without price or without a rate has unknown cost (None, never 0).
"""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import date
import re
from urllib.parse import urlsplit

# 落盘后的封面引用（storage.stash_cover 生成）；data URL 仅限备份恢复等旧数据通道
COVER_URL_RE = re.compile(r'^/api/cover/[0-9a-f]{16}\.(jpg|png|webp)$')

STATUSES = ('overseas', 'transit', 'domestic', 'shipping', 'sold', 'trash')
MODULE_NAMES = ('acquisition', 'trading', 'circulation', 'showcase')
SHOWCASE_ID_RE = re.compile(r'^[0-9a-f]{32}$')


class ValidationError(ValueError):
    pass


class ConflictError(ValidationError):
    """预期状态与当前不一致（其他端已修改）；路由层映射为 HTTP 409。"""


RELEASE_FIELDS = ('catalogNumber', 'barcode', 'label', 'country', 'releaseDate',
                  'edition', 'format', 'discCount', 'matrix', 'extras', 'observations')


def clean_release_info(value):
    if not isinstance(value, dict): raise ValidationError('发行资料格式不正确')
    result = {}
    for key in RELEASE_FIELDS:
        text = value.get(key, '')
        if text is None: text = ''
        if not isinstance(text, str) or len(text) > 5000:
            raise ValidationError('发行资料应为文字，且每项不超过 5000 字')
        result[key] = text.strip()
    tracks = value.get('tracklist', [])
    if not isinstance(tracks, list) or len(tracks) > 500 or any(not isinstance(t, str) or len(t) > 500 for t in tracks):
        raise ValidationError('曲目资料格式不正确')
    result['tracklist'] = [t.strip() for t in tracks if t.strip()]
    return result


def clean_modules(enabled):
    """内置模块的唯一配置契约；海外周转需要购入记录来追溯分摊成本。"""
    # 旧客户端、已保存配置与旧备份只有三个业务开关；新增展示能力默认关闭。
    if not isinstance(enabled, dict) or set(enabled) not in (set(MODULE_NAMES), set(MODULE_NAMES) - {'showcase'}):
        raise ValidationError('请提供完整的模块配置')
    if any(type(value) is not bool for value in enabled.values()):
        raise ValidationError('模块开关必须为布尔值')
    if enabled['circulation'] and not enabled['acquisition']:
        raise ValidationError('海外周转需要同时启用购入记录')
    return {k: enabled.get(k, False) for k in MODULE_NAMES}


def clean_start_page(value):
    if not isinstance(value, str) or value not in ('domestic', 'gallery'):
        raise ValidationError('首页必须为收藏或展示')
    return value


def clean_showcase_group(value):
    """展示组是有序的实物 ID 清单，不合并作品或要求外部艺人绑定。"""
    if not isinstance(value, dict) or set(value) != {'id', 'name', 'recordIds'}:
        raise ValidationError('展示组格式不正确')
    ident = value['id']
    if not isinstance(ident, str) or not SHOWCASE_ID_RE.fullmatch(ident):
        raise ValidationError('展示组编号不正确')
    name = value['name']
    if not isinstance(name, str) or not 1 <= len(name.strip()) <= 100:
        raise ValidationError('展示组名称应为 1–100 字')
    ids = value['recordIds']
    if not isinstance(ids, list) or len(ids) > 10000:
        raise ValidationError('展示组的副本清单不正确')
    if any(not isinstance(rid, str) or not SHOWCASE_ID_RE.fullmatch(rid) for rid in ids):
        raise ValidationError('展示组的副本编号不正确')
    if len(set(ids)) != len(ids):
        raise ValidationError('同一副本不能在展示组中重复')
    return {'id': ident, 'name': name.strip(), 'recordIds': list(ids)}


def clean_showcase_groups(value):
    """meta/备份的唯一展示组契约；允许历史清单含目前不存在的副本。"""
    if not isinstance(value, dict) or set(value) != {'revision', 'groups'}:
        raise ValidationError('展示组设置格式不正确')
    revision = value['revision']
    if type(revision) is not int or revision < 0:
        raise ValidationError('展示组版本不正确')
    if not isinstance(value['groups'], list) or len(value['groups']) > 1000:
        raise ValidationError('展示组清单不正确')
    groups = [clean_showcase_group(group) for group in value['groups']]
    if len({group['id'] for group in groups}) != len(groups):
        raise ValidationError('展示组编号重复')
    return {'revision': revision, 'groups': groups}


def clean_listing(data):
    if not isinstance(data, dict): raise ValidationError('上架资料格式不正确')
    channel = str(data.get('channel', '')).strip()
    url = str(data.get('url', '')).strip()
    if len(channel) > 100 or len(url) > 2000: raise ValidationError('上架资料过长')
    try:
        parsed = urlsplit(url)
        valid = parsed.scheme in ('http', 'https') and parsed.hostname and not parsed.username and not parsed.password
    except ValueError:
        valid = False
    if url and not valid: raise ValidationError('请填写 http 或 https 商品链接')
    result = {'listingChannel': channel, 'listingUrl': url}
    if 'description' in data:
        description = data['description']
        if not isinstance(description, str) or len(description)>50000: raise ValidationError('上架描述过长或格式不正确')
        result['listingDescription'] = description
    return result


def number(value, name='金额', optional=False):
    if value in ('', None):
        if optional: return None
        raise ValidationError(f'请填写{name}')
    try: n = Decimal(str(value))
    except (InvalidOperation, ValueError): raise ValidationError(f'{name}必须是数字')
    if not n.is_finite() or n < 0 or n > Decimal('1000000000'):
        raise ValidationError(f'{name}必须在 0 到 10 亿之间')
    return n


def money(value):
    return str(Decimal(value).quantize(Decimal('.01'), rounding=ROUND_HALF_UP))


def day(value, name='日期', optional=False):
    if not value and optional: return ''
    try: return date.fromisoformat(str(value)).isoformat()
    except (ValueError, TypeError): raise ValidationError(f'{name}格式应为 YYYY-MM-DD')


def clean_record(data):
    r = dict(data)
    for k in ('title','artist'):
        r[k] = str(r.get(k,'')).strip()
        if not r[k]: raise ValidationError(f'请填写{"专辑名" if k == "title" else "艺人"}')
        if len(r[k]) > 500: raise ValidationError('名称过长')
    r['date'] = day(r.get('date'), '买入日期', optional=True)
    r['currency'] = 'CNY' if r.get('currency') == 'RMB' else r.get('currency','JPY')
    if r['currency'] not in ('CNY','JPY'): raise ValidationError('买入币种应为日元或人民币')
    price = number(r.get('price'), '买入金额', optional=True)
    r['price'] = money(price) if price is not None else ''
    fees = number(r.get('fees',0), '额外买入费用', optional=True)
    r['fees'] = money(fees) if fees is not None else '0.00'
    actual = number(r.get('actual'), '实际人民币支出', optional=True)
    r['actual'] = money(actual) if actual is not None else ''
    if r['actual'] != '': r['rate'] = ''
    if r['currency'] == 'CNY': r['actual'] = ''
    r.pop('rate', None)
    r.pop('rateSource', None)
    r.pop('listed', None)  # 上架标记只经 storage.bulk 的 list/unlist 写入，表单通道不可改
    r.pop('listingChannel', None)
    r.pop('listingUrl', None)
    for k in ('location','note','noteAlbum','tradeNote','version','pressing','obi','condition','tag','storage','releaseYear','rawRemark'):
        r[k] = str(r.get(k,'')).strip()
        if len(r[k]) > 50000: raise ValidationError('备注过长')
    cover = str(r.get('cover',''))
    if cover.startswith('data:image/') and len(cover) > 3000000: raise ValidationError('封面数据过大')
    if cover and not (COVER_URL_RE.match(cover) or cover.startswith(
            ('data:image/jpeg;base64,','data:image/png;base64,','data:image/webp;base64,'))):
        raise ValidationError('封面数据不正确')
    r['cover'] = cover
    if 'releaseInfo' in r: r['releaseInfo'] = clean_release_info(r['releaseInfo'])
    if 'listingDescription' in r:
        if not isinstance(r['listingDescription'], str) or len(r['listingDescription']) > 50000:
            raise ValidationError('上架描述过长或格式不正确')
    return r


def cost(r, rate=None):
    """RMB cost as Decimal, or None when unknown.

    rate: CNY per 100 JPY for the buy date (str/Decimal), from RateService.
    """
    fees = Decimal(r.get('fees') or 0)
    if r.get('actual') not in ('', None): base = Decimal(r['actual'])
    elif r.get('price') in ('', None): return None
    elif r['currency'] == 'CNY': base = Decimal(r['price'])
    elif rate in ('', None): return None
    else: base = Decimal(r['price']) * Decimal(rate) / 100
    return Decimal(money(base + fees))


def allocate(total, weights):
    """Round each share down; distribute remaining cents deterministically."""
    total = Decimal(money(total))
    if not weights: raise ValidationError('请选择专辑')
    weights = [Decimal(w) for w in weights]
    if sum(weights) <= 0: weights = [Decimal(1)] * len(weights)
    cents = int(total * 100)
    raw = [Decimal(cents) * w / sum(weights) for w in weights]
    parts = [int(n) for n in raw]
    order = sorted(range(len(raw)), key=lambda i: raw[i]-parts[i], reverse=True)
    for i in order[:cents-sum(parts)]: parts[i] += 1
    return [money(Decimal(n)/100) for n in parts]
