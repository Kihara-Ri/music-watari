// 售出中与已交易共用销售单卡片：专辑、金额与操作集中展示。
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import type {AlbumRecord, Sale} from '../types';
import {SALE_NAMES, labelTags} from '../types';
import {daysSince, shipFeeText, sum, yuan} from '../core/format';
import {AlbumSummary} from './AlbumSummary';
import {Cover} from './Cover';
import {openDetail} from '../forms/DetailDrawer';
import {CONFIRM_TITLES, ConfirmForm} from '../forms/ConfirmForm';

function openConfirm(app: AppCtx, kind: keyof typeof CONFIRM_TITLES,
                    opts: {id?: string; sale?: Sale; arriveCount?: number} = {}) {
  app.openDrawer({title: CONFIRM_TITLES[kind], asForm: true,
    content: <ConfirmForm kind={kind} id={opts.id} sale={opts.sale} arriveCount={opts.arriveCount}/>});
}

// 完整销售单；多张合单仍按独立副本展示。
export function SaleCard({s, onArtist, onEditCosts}: {s: Sale; onArtist: (artist: string) => void; onEditCosts: () => void}) {
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
            <AlbumSummary key={i.recordId} r={r} onDetail={() => openDetail(app, r.id)} onArtist={onArtist} money={<>
              {app.modules.acquisition ? <small>{r.cost === null ? '成本待补' : `成本 ${yuan(r.cost)}`}</small> : null}
              <div className="album-money-main">
                <small>{shipping ? '预计到手' : '到手'}</small>
                <b>{yuan(i.net)}</b>
                {app.modules.acquisition ? i.profit !== null
                  ? <small className={Number(i.profit) < 0 ? 'negative' : 'positive'}>
                    {shipping ? '预估利润' : '利润'} {yuan(i.profit)}
                  </small>
                  : <small>利润待补</small> : null}
              </div>
            </>}/>
          );
        })}
      </div>
      <div className="sale-foot">
        <div className="cell"><span>成交价</span><b>{shipFeeText(s.currency, s.grossOriginal, s.gross)}</b></div>
        <div className="cell"><span>平台扣费</span><b>−{shipFeeText(s.currency, s.feesOriginal, s.fees)}</b></div>
        <div className="cell"><span>寄出运费</span><b>−{shipFeeText(s.currency, s.postageOriginal, s.postage || '0')}</b></div>
        {s.items.length > 1 ? <div className="cell"><span>{shipping ? '预计到手合计' : '到手合计'}</span><b>{yuan(net)}</b></div> : null}
        {s.items.length > 1 && app.modules.acquisition ? <div className="cell">
          <span>{unknown ? (shipping ? '预估利润（待补）' : '利润（待补）') : shipping ? '预估利润' : '利润'}</span>
          <b className={unknown ? '' : Number(profit) < 0 ? 'negative' : 'positive'}>
            {unknown ? '待补' : yuan(profit)}
          </b>
        </div> : null}
        <span className="spacer"/>
        {(shipping || s.status === 'complete') && (
          <div className="actions">
            <button onClick={onEditCosts}>修改费用</button>
            {shipping ? <>
            <button className="primary" onClick={() => openConfirm(app, 'receive', {id: s.id})}>确认收货</button>
            <button onClick={() => openConfirm(app, 'refund', {id: s.id, sale: s})}>退款 / 退货</button>
            <button className="quiet" onClick={() => openConfirm(app, 'cancel', {id: s.id})}>撤销</button>
            </> : null}
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
