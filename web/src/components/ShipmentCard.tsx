// 海外在途：包裹卡片（在途 / 已签收可回滚）。
import {daysSince, shipFeeText} from '../core/format';
import {labelTags} from '../types';
import type {Shipment} from '../types';
import {useApp} from '../state/AppContext';
import {ArtistButton} from './ArtistButton';
import {Thumb} from './Cover';
import {openDetail} from '../forms/DetailDrawer';
import {openConfirm} from './SaleCard';
import {openShipmentEdit} from '../forms/ShipForm';

export function ShipmentCard({s, arrived, onArtist}: {s: Shipment; arrived: boolean; onArtist: (artist: string) => void}) {
  const app = useApp();
  const days = daysSince(s.date);
  return (
    <article className={`shipment-card${arrived ? ' arrived' : ''}`}>
      <div className="shipment-head">
        <span className="method">{s.method}</span>
        {arrived
          ? <span className="pill domestic">已签收 {s.arrivedDate}</span>
          : <span className="pill transit">在途 {days} 天</span>}
        <span className="meta">
          {s.date} 发货 · {s.items.length} 张 · 运费 {shipFeeText(s.currency, s.costOriginal, s.cost)}{s.note ? ` · ${s.note}` : ''}
        </span>
        <span className="spacer"/>
        <div className="actions" style={{display: 'flex', gap: 7}}>
          {arrived ? (
            <button onClick={() => openConfirm(app, 'undo_arrive', {id: s.id})}>回滚签收</button>
          ) : (
            <>
              <button className="primary" onClick={() => openConfirm(app, 'arrive', {id: s.id, arriveCount: s.items.length})}>确认签收</button>
              <button onClick={() => openShipmentEdit(app, s.id)}>编辑</button>
              <button className="quiet" onClick={() => openConfirm(app, 'cancel_shipment', {id: s.id})}>撤销</button>
            </>
          )}
        </div>
      </div>
      <div className="shipment-items">
        {s.items.map(i => {
          const r = app.rec(i.recordId);
          if (!r) return null;
          const tags = labelTags(r);
          return (
            <div className="sale-album" key={i.recordId}>
              <Thumb r={r}/>
              <div>
                <button className="t" onClick={() => openDetail(app, r.id)}>{r.title}</button>
                <ArtistButton artist={r.artist} onOpen={onArtist}/>
                {tags.length ? <div className="a">{tags.join(' · ')}</div> : null}
              </div>
              <div className="sa-price"><small>运费分摊 {shipFeeText(s.currency, i.feeOriginal, i.fee)}</small></div>
            </div>
          );
        })}
      </div>
    </article>
  );
}
