"""CSV 导出：销售流水与库存清单。所有单元格做 CSV 注入防护。"""
import csv
import io

SALE_STATUS = {'shipping': '售出中', 'complete': '已售出', 'cancelled': '已撤销',
               'returned': '已退货', 'refunded': '已退款'}
RECORD_STATUS = {'overseas': '海外库存', 'transit': '海外在途', 'domestic': '国内库存',
                 'shipping': '售出中', 'sold': '已售出', 'trash': '回收站'}
_INJECTED = ('=', '+', '-', '@', '\t', '\r')


def _cell(v):
    v = str(v if v is not None else '')
    return "'" + v if v.startswith(_INJECTED) else v


def _csv_bytes(rows):
    out = io.StringIO()
    w = csv.writer(out)
    for row in rows: w.writerow(row)
    return ('\ufeff' + out.getvalue()).encode()


def sales_csv(state):
    rows = [['售出日期', '到账日期', '状态', '专辑', '艺人', '分摊成交价', '分摊平台扣费',
             '分摊寄出运费', '退款', '到手金额', '利润', '渠道', '订单号', '买家地址']]
    records = {r['id']: r for r in state['records']}
    for sale in state['sales']:
        for item in sale['items']:
            r = records[item['recordId']]
            rows.append([_cell(v) for v in [
                sale['date'], sale.get('receivedDate', ''),
                SALE_STATUS.get(sale['status'], sale['status']),
                r['title'], r['artist'], item['gross'], item['fees'],
                item.get('postage', '0'), item.get('refund', '0'), item['net'],
                item['profit'] if item['profit'] is not None else '成本待补',
                sale.get('channel', ''), sale.get('orderId', ''), sale.get('address', '')]])
    return _csv_bytes(rows)


def albums_csv(state):
    rows = [['专辑', '艺人', '状态', '上架', '购买日期', '渠道', '碟盒', '版次', '侧标', '币种',
             '买入金额', '100日元兑人民币', '实际人民币支出', '额外买入费用', '人民币成本', '笔记', '存放位置', '上架平台', '商品链接',
             '唱片编号', '条码', '厂牌', '发行地区', '本版发行日期', '发行版本', '介质', '碟数', '内圈刻码', '可见附件', '照片可见情况', '曲目', '上架描述']]
    for r in state['records']:
        release = r.get('releaseInfo', {})
        rows.append([_cell(v) for v in [
            r['title'], r['artist'], RECORD_STATUS.get(r['status'], r['status']),
            '是' if r.get('listed') else '',
            r.get('date'), r.get('location'), r.get('version'), r.get('pressing'), r.get('obi'),
            r.get('currency'), r.get('price'), r.get('rate'), r.get('actual'),
            r.get('fees'), r.get('cost'), r.get('note'), r.get('storage'), r.get('listingChannel'), r.get('listingUrl'),
            *[release.get(k) for k in ('catalogNumber','barcode','label','country','releaseDate','edition','format','discCount','matrix','extras','observations')],
            '\n'.join(release.get('tracklist',[])), r.get('listingDescription')]])
    return _csv_bytes(rows)
