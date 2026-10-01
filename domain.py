"""Decimal accounting and input validation, independent of storage and HTTP.

Cost model: JPY purchases are valued at the ECB reference rate for the buy
date (auto-fetched, cached); an explicit actual-CNY amount still wins.
A record without price or without a rate has unknown cost (None, never 0).
"""
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from datetime import date

STATUSES = ('overseas', 'transit', 'domestic', 'shipping', 'sold', 'trash')
MODULE_NAMES = ('acquisition', 'trading', 'circulation')


class ValidationError(ValueError):
    pass
def clean_modules(enabled):
    """内置模块的唯一配置契约；海外周转需要购入记录来追溯分摊成本。"""
    if not isinstance(enabled, dict) or set(enabled) != set(MODULE_NAMES):
        raise ValidationError('请提供完整的模块配置')
    if any(type(enabled[k]) is not bool for k in MODULE_NAMES):
        raise ValidationError('模块开关必须为布尔值')
    if enabled['circulation'] and not enabled['acquisition']:
        raise ValidationError('海外周转需要同时启用购入记录')
    return {k: enabled[k] for k in MODULE_NAMES}




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
    for k in ('location','note','noteAlbum','tradeNote','version','pressing','obi','condition','tag','storage','releaseYear','rawRemark'):
        r[k] = str(r.get(k,'')).strip()
        if len(r[k]) > 50000: raise ValidationError('备注过长')
    cover = str(r.get('cover',''))
    if cover and not (cover.startswith('data:image/jpeg;base64,') or cover.startswith('data:image/png;base64,') or cover.startswith('data:image/webp;base64,')):
        raise ValidationError('封面数据不正确')
    if len(cover) > 3000000: raise ValidationError('封面数据过大')
    r['cover'] = cover
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
