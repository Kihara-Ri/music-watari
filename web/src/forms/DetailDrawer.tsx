// 专辑详情抽屉：封面大图、字段、实物照片墙、双笔记、运输与交易历史。
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import {fmt, fmtJPY, jpyCost, rmb, shipFeeText, yuan} from '../core/format';
import {SALE_NAMES} from '../types';
import {statusName} from '../core/modules';
import {Cover} from '../components/Cover';
import {openRecordForm} from './RecordForm';
import {openSaleForm} from './SaleForm';
import {openListingForm} from './ListingForm';
import {bulkAction} from './shared';
import {releaseLabels} from '../core/recognition';

export function openDetail(app: AppCtx, id: string) {
  const r = app.rec(id);
  if (!r) { app.toast('记录不存在，请刷新页面', 'err'); return; }
  app.openDrawer({title: '专辑详情', content: <DetailBody id={id}/>, footer: <DetailFooter id={id}/>});
}

function DetailBody({id}: {id: string}) {
  const app = useApp();
  const {modules} = app;
  const r = app.rec(id);
  if (!r) return null;
  const sales = app.state.sales.filter(s => s.items.some(i => i.recordId === id));
  const shipment = r.shipmentId ? app.state.shipments.find(s => s.id === r.shipmentId) : undefined;
  const shipItem = shipment && shipment.currency === 'JPY'
    ? shipment.items.find(i => i.recordId === id) : undefined;
  const approx = jpyCost(r);
  const tags: [string, React.ReactNode][] = [
    ...(modules.acquisition ? [
    ['买入金额', r.price === '' ? '待补'
      : `${r.currency === 'JPY' ? fmtJPY(r.price) : fmt(r.price)} ${r.currency === 'JPY' ? '日元' : '人民币'}`
        + (approx ? ` ` : '')],
    ['买入日期', r.date || '待补'],
    ['购买渠道', r.location || '—'],
    ['当日汇率', r.currency === 'JPY' && r.rate ? `100 円 = ¥${Number(r.rate).toFixed(2)}` : '—'],
    ['额外费用（含运费分摊）', r.fees && Number(r.fees) ? yuan(r.fees) : '—'],
    ] as [string, React.ReactNode][] : []),
    ['存放位置', r.storage || '—'],
    ['碟盒', r.version || '—'],
    ['版次', r.pressing ? (r.pressing === '日版' && r.obi ? `${r.pressing}（${r.obi}）` : r.pressing) : '—'],
  ];
  return (
    <div>
      <div className="record-detail">
        <div className="big"><Cover r={r}/></div>
        <div>
          <h2>{r.title}</h2>
          <p className="artist">{r.artist}</p>
          <span className={`pill ${r.status}`}>{statusName(r.status, app.modules)}</span>
          {app.modules.trading && r.listed ? <span className="pill listed">已上架</span> : null}
        </div>
      </div>
      <dl className="detail-grid">
        {tags.map(([k, val]) => (
          <div key={k}><dt>{k}</dt><dd>
            {k === '买入金额' && approx ? <>{val} <span className="rmb">{rmb(approx)}</span></> : val}
            {k === '额外费用（含运费分摊）' && shipItem?.feeOriginal
              ? <> <span className="rmb">含国际运费 {fmtJPY(shipItem.feeOriginal)} 円 ≈ {yuan(shipItem.fee)}</span></>
              : null}
          </dd></div>
        ))}
      </dl>
      {app.modules.trading && (r.listingChannel || r.listingUrl) ? <>
        <h3 className="section-title">上架资料</h3>
        <p className="small-note">{r.listingChannel || '未填写平台'}
          {r.listingUrl ? <> · <a href={r.listingUrl} target="_blank" rel="noopener noreferrer">打开商品页面 ↗</a></> : null}
        </p>
      </> : null}
      {r.photoCount ? (
        <>
          <h3 className="section-title">实物照片</h3>
          <div className="photo-strip">
            {Array.from({length: r.photoCount}, (_, i) => (
              <a key={i} href={`/api/photo/${r.id}/${i}`} target="_blank" rel="noopener">
                <img src={`/api/photo/${r.id}/${i}`} loading="lazy" alt={`实物照片 ${i + 1}`}/>
              </a>
            ))}
          </div>
        </>
      ) : null}
      {r.note ? <><h3 className="section-title">笔记 · 这张副本</h3><p className="note-text">{r.note}</p></> : null}
      {r.releaseInfo && Object.values(r.releaseInfo).some(v => Array.isArray(v) ? v.length : v) ? <>
        <h3 className="section-title">发行资料</h3>
        <dl className="detail-grid">{releaseLabels.map(([key,label]) => r.releaseInfo?.[key] ? <div key={key}><dt>{label}</dt><dd>{r.releaseInfo[key]}</dd></div> : null)}</dl>
        {r.releaseInfo.tracklist?.length ? <details className="adv"><summary>曲目 · {r.releaseInfo.tracklist.length} 首</summary><p className="note-text">{r.releaseInfo.tracklist.join('\n')}</p></details> : null}
      </> : null}
      {r.recognition ? <details className="adv"><summary>识别依据与资料来源</summary>
        <p className="small-note">{r.recognition.model} · {r.recognition.at.replace('T',' ')}</p>
        {r.recognition.evidence.map((e,i) => <p className="recognition-evidence" key={i}>照片 {e.photo} · {e.value || e.field}{e.note ? `：${e.note}` : ''}</p>)}
        {r.recognition.sources.map((s,i) => <a className="recognition-source" key={i} href={s.url} target="_blank" rel="noopener noreferrer">{s.title} ↗</a>)}
      </details> : null}
      {modules.trading && r.listingDescription ? <>
        <h3 className="section-title">上架描述草稿</h3><p className="note-text listing-description">{r.listingDescription}</p>
        <button type="button" className="quiet" onClick={async () => {try {await navigator.clipboard.writeText(r.listingDescription!);app.toast('上架描述已复制');}catch{app.toast('复制失败，可选中文字手动复制','warn');}}}>复制上架描述</button>
      </> : null}
      {r.noteAlbum ? <><h3 className="section-title">笔记 · 这张专辑</h3><p className="note-text">{r.noteAlbum}</p></> : null}
      {app.modules.circulation && shipment && shipment.status !== 'cancelled' ? (
        <>
          <h3 className="section-title">运输包裹</h3>
          <p className="small-note">
            {shipment.method} · {shipment.date} 发货
            {shipment.arrivedDate ? ` · 已签收 ${shipment.arrivedDate}` : ' · 在途'}
            {' '}· 运费分摊 {shipFeeText(shipment.currency,
              shipment.items.find(i => i.recordId === id)?.feeOriginal,
              shipment.items.find(i => i.recordId === id)?.fee || 0)}
          </p>
        </>
      ) : null}
      {app.modules.trading && sales.length ? (
        <>
          <h3 className="section-title">交易历史</h3>
          {sales.map(s => {
            const item = s.items.find(i => i.recordId === id)!;
            return (
              <p className="small-note" key={s.id}>
                {s.date} 售出 · {SALE_NAMES[s.status]}
                {s.receivedDate ? ` · 到账 ${s.receivedDate}` : ''} · 到手 {yuan(item.net)}
                {app.modules.acquisition && item.profit !== null ? ` · 利润 ${yuan(item.profit)}` : ''}
                {s.address ? ` · ${s.address}` : ''}
              </p>
            );
          })}
        </>
      ) : null}
    </div>
  );
}

function DetailFooter({id}: {id: string}) {
  const app = useApp();
  const r = app.rec(id);
  if (!r) return null;
  return (
    <>
      <button onClick={() => openRecordForm(app, id)}>编辑</button>
      {app.modules.trading && ['overseas', 'domestic'].includes(r.status)
        ? <button className="quiet" onClick={() => openListingForm(app, id)}>上架资料</button> : null}
      {app.modules.trading && ['overseas', 'domestic'].includes(r.status)
        ? <button className="quiet" onClick={() => bulkAction(app, r.listed ? 'unlist' : 'list', [id], r.listed ? '已取消上架' : '已标记上架')}>
            {r.listed ? '取消上架' : '标记上架'}</button> : null}
      {app.modules.circulation && r.status === 'domestic'
        ? <button className="quiet" onClick={() => bulkAction(app, 'to_overseas', [id])}>调回海外</button> : null}
      {['overseas', 'domestic'].includes(r.status) ? (
        <button className="quiet danger"
                onClick={() => bulkAction(app, 'delete', [id], '已移入回收站，可在设置中恢复')}>移除</button>
      ) : null}
      {app.modules.trading && ['domestic', 'overseas'].includes(r.status)
        ? <button className="primary" onClick={() => openSaleForm(app, [id])}>记录售出</button> : null}
    </>
  );
}
