import {openArtistDrawer} from '../forms/ArtistDrawer';
// 海外在途页：在途包裹 + 最近签收（可回滚）。
import {sum, yuan} from '../core/format';
import {useApp} from '../state/AppContext';
import {PageHead} from '../components/PageHead';
import {ShipmentCard} from '../components/ShipmentCard';

export function TransitPage() {
  const app = useApp();
  const {state} = app;
  const shs = state.shipments.filter(s => s.status === 'transit');
  const arrived = state.shipments.filter(s => s.status === 'arrived')
    .sort((a, b) => (b.arrivedDate || '').localeCompare(a.arrivedDate || ''))
    .slice(0, 6);
  const albumCount = shs.flatMap(s => s.items).length;

  return (
    <div className="align-list">
      <PageHead title="海外在途" label="IN TRANSIT"/>
      <div className="summary">
        <span><strong>{shs.length}</strong> 个在途包裹</span>
        <span><strong>{albumCount}</strong> 张专辑</span>
        <span>运费合计 <strong>{yuan(sum(shs, 'cost'))}</strong></span>
      </div>
      {(shs.length || arrived.length) ? (
        <>
          {shs.map(s => <ShipmentCard key={s.id} s={s} arrived={false} onArtist={name => openArtistDrawer(app, name)}/>)}
          <div className="section-sub">最近签收 · 可回滚</div>
          {arrived.length
            ? arrived.map(s => <ShipmentCard key={s.id} s={s} arrived onArtist={name => openArtistDrawer(app, name)}/>)
            : <p className="small-note">暂无已签收包裹。</p>}
        </>
      ) : (
        <div className="empty">
          <div className="empty-symbol">✈</div>
          <h3>没有在途包裹</h3>
          <p>在海外库存勾选多张专辑，打包为一趟运输。</p>
          <a className="link-button" href="#overseas">去海外库存</a>
        </div>
      )}
    </div>
  );
}
