// 销售单卡片（已交易页完整版 / 售出中页精简条）与售出中专辑卡。
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import type {AlbumRecord, Sale} from '../types';
import {SALE_NAMES, labelTags} from '../types';
import {daysSince, sum, yuan} from '../core/format';
import {Cover} from './Cover';
import {openDetail} from '../forms/DetailDrawer';
import {CONFIRM_TITLES, ConfirmForm} from '../forms/ConfirmForm';

function openConfirm(app: AppCtx, kind: keyof typeof CONFIRM_TITLES,
                    opts: {id?: string; sale?: Sale; arriveCount?: number} = {}) {
  app.openDrawer({title: CONFIRM_TITLES[kind], asForm: true,
    content: <ConfirmForm kind={kind} id={opts.id} sale={opts.sale} arriveCount={opts.arriveCount}/>});
}

// 售出中的专辑卡（封面 + 预计到手 + 预估利润）
export function ShippingCard({r}: {r: AlbumRecord}) {
  const app = useApp();
  const s = app.state.sales.find(x => x.id === r.saleId);
  const item = s?.items.find(i => i.recordId === r.id);
  const h = [...r.artist].reduce((a, c) => a + c.charCodeAt(0), 0) % 4;
  return (
    <article className="card">
      <div className="cover-wrap">
        {r.cover
          ? <img className="cover" src={r.cover} alt="" loading="lazy"/>
          : <div className={`cover cover-fallback hue-${h}`}><span>{r.title.slice(0, 1)}</span></div>}
        <span className="badge transit">已 {daysSince(s?.date)} 天</span>
      </div>
      <div className="card-body">
        <button className="card-title" onClick={() => openDetail(app, r.id)}>{r.title}</button>
        <div className="card-artist">{r.artist}</div>
        <div className="card-price">
          <span className="p">{item ? yuan(item.net) : '—'}<small>预计到手</small></span>
          {app.modules.acquisition && item && item.profit !== null
            ? <span className={`rmb ${Number(item.profit) < 0 ? 'negative' : 'positive'}`}>预估利润 {yuan(item.profit)}</span>
            : null}
        </div>
      </div>
      <div className="card-actions">
        <button onClick={() => openDetail(app, r.id)}>详情</button>
      </div>
    </article>
  );
}

// 售出中页的销售单操作条（整单确认）
export function ShippingBar({s}: {s: Sale}) {
  const app = useApp();
  return (
    <article className="sale-card">
      <div className="sale-top">
        <span className="pill shipping">售出中</span>
        <span className="when">
          {s.date} 售出 · {s.channel}{s.orderId ? ` · 单 ${s.orderId}` : ''}{s.address ? ` · ${s.address}` : ''}
        </span>
        <span className="spacer"/>
        <span className="when">{s.items.length} 张 · 到手 {yuan(sum(s.items, 'net'))}</span>
      </div>
      <div className="sale-foot">
        <div className="cell"><span>成交价</span><b>{yuan(s.gross)}</b></div>
        {Number(s.fees) ? <div className="cell"><span>平台扣费</span><b>−{yuan(s.fees)}</b></div> : null}
        {Number(s.postage) ? <div className="cell"><span>寄出运费</span><b>−{yuan(s.postage)}</b></div> : null}
        <span className="spacer"/>
        <div className="actions">
          <button className="primary" onClick={() => openConfirm(app, 'receive', {id: s.id})}>确认收货</button>
          <button onClick={() => openConfirm(app, 'refund', {id: s.id, sale: s})}>退款 / 退货</button>
          <button className="quiet" onClick={() => openConfirm(app, 'cancel', {id: s.id})}>撤销</button>
        </div>
      </div>
    </article>
  );
}

// 完整销售单（已交易页；也兼容售出中状态的展示分支）
export function SaleCard({s}: {s: Sale}) {
  const app = useApp();
  const unknown = s.items.some(i => i.profit === null);
  const net = sum(s.items, 'net');
  const profit = sum(s.items, 'profit');
  const shipping = s.status === 'shipping';
  const pill = shipping
    ? <span className="pill shipping">售出中</span>
    : <span className={`pill ${s.status === 'complete' ? 'sold' : 'pending-pill'}`}>{SALE_NAMES[s.status]}</span>;
  const info = [
    `${s.date} 售出`, s.channel,
    shipping ? `已 ${daysSince(s.date)} 天` : (s.receivedDate ? `到账 ${s.receivedDate}` : ''),
    s.orderId ? `单 ${s.orderId}` : '', s.address || '',
  ].filter(Boolean).join(' · ');
  return (
    <article className="sale-card">
      <div className="sale-top">
        {pill}
        <span className="when">{info}</span>
        <span className="spacer"/>
        <span className="when">{s.items.length} 张{s.note ? ` · ${s.note}` : ''}</span>
      </div>
      <div className="sale-items">
        {s.items.map(i => {
          const r = app.rec(i.recordId);
          if (!r) return null;
          return (
            <div className="sale-album" key={i.recordId}>
              <div className="thumb"><Cover r={r}/></div>
              <div>
                <button className="t" onClick={() => openDetail(app, r.id)}>{r.title}</button>
                <div className="a">
                  {r.artist}{app.modules.acquisition ? (r.cost === null ? ' · 成本待补' : ` · 成本 ${yuan(r.cost)}`) : ''}
                </div>
              </div>
              <div className="sa-price">
                <b>{yuan(i.net)}</b>
                {app.modules.acquisition ? i.profit !== null
                  ? <small className={Number(i.profit) < 0 ? 'negative' : 'positive'}>
                    {shipping ? '预估' : '利润'} {yuan(i.profit)}
                  </small>
                  : <small>利润待补</small> : null}
              </div>
            </div>
          );
        })}
      </div>
      <div className="sale-foot">
        <div className="cell"><span>成交价</span><b>{yuan(s.gross)}</b></div>
        {Number(s.fees) ? <div className="cell"><span>平台扣费</span><b>−{yuan(s.fees)}</b></div> : null}
        {Number(s.postage) ? <div className="cell"><span>寄出运费</span><b>−{yuan(s.postage)}</b></div> : null}
        <div className="cell"><span>{shipping ? '预计到手' : '到手'}</span><b>{yuan(net)}</b></div>
        {app.modules.acquisition ? <div className="cell">
          <span>{unknown ? (shipping ? '预估利润（待补）' : '利润（待补）') : shipping ? '预估利润' : '利润'}</span>
          <b className={unknown ? '' : Number(profit) < 0 ? 'negative' : 'positive'}>
            {unknown ? '待补' : yuan(profit)}
          </b>
        </div> : null}
        <span className="spacer"/>
        {shipping && (
          <div className="actions">
            <button className="primary" onClick={() => openConfirm(app, 'receive', {id: s.id})}>确认收货</button>
            <button onClick={() => openConfirm(app, 'refund', {id: s.id, sale: s})}>退款 / 退货</button>
            <button className="quiet" onClick={() => openConfirm(app, 'cancel', {id: s.id})}>撤销</button>
          </div>
        )}
      </div>
    </article>
  );
}

// 合单售出表单里展示的专辑行（也用于打包表单）
export function AlbumLine({r, showCost = true}: {r: AlbumRecord; showCost?: boolean}) {
  const tags = labelTags(r);
  return (
    <div className="sale-album">
      <div className="thumb"><Cover r={r}/></div>
      <div>
        <strong>{r.title}</strong>
        <div className="a">
          {r.artist}{tags.length ? ` · ${tags.join(' · ')}` : ''}
          {showCost ? (r.cost === null ? ' · 成本待补' : ` · 成本 ${yuan(r.cost)}`) : ''}
        </div>
      </div>
    </div>
  );
}

export {openConfirm};
