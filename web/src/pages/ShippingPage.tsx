import {openArtistDrawer} from '../forms/ArtistDrawer';
// 售出中页：按销售单合并展示专辑、金额与整单操作。
import {sum, yuan} from '../core/format';
import {useApp} from '../state/AppContext';
import {PageHead} from '../components/PageHead';
import {SaleCard} from '../components/SaleCard';
import {openSaleCostsForm} from '../forms/SaleCostsForm';

export function ShippingPage() {
  const app = useApp();
  const {state, modules} = app;
  const rs = state.records.filter(r => r.status === 'shipping');
  const sales = state.sales.filter(s => s.status === 'shipping');
  const items = sales.flatMap(s => s.items);
  const ks = items.filter(i => i.profit !== null);

  return (
    <>
      <PageHead title="售出中"
                desc="每单集中查看专辑与费用。买家签收且钱款到账后点「确认收货」；平台扣费可在到账后补录或修改。"/>
      <div className="summary">
        <span><strong>{rs.length}</strong> 张专辑</span>
        <span><strong>{sales.length}</strong> 个销售单</span>
        <span>预计到手 <strong>{yuan(sum(items, 'net'))}</strong></span>
        {modules.acquisition ? <span>预估利润 <strong className={sum(ks, 'profit') < 0 ? 'negative' : 'positive'}>
          {ks.length ? yuan(sum(ks, 'profit')) : '—'}
        </strong></span> : null}
        {modules.acquisition && items.length - ks.length ? <span className="hint">{items.length - ks.length} 条成本待补</span> : null}
      </div>
      {sales.length ? (
        <div id="sales-list">
          {sales.map(s => <SaleCard key={s.id} s={s} onArtist={name => openArtistDrawer(app, name)} onEditCosts={() => openSaleCostsForm(app, s)}/>)}
        </div>
      ) : (
        <div className="empty">
          <div className="empty-symbol">◨</div>
          <h3>没有售出中的专辑</h3>
          <p>在{modules.circulation ? '国内库存' : '我的收藏'}点击「记录售出」后，专辑会在这里等待买家签收。</p>
          <a className="link-button" href="#domestic">查看{modules.circulation ? '国内库存' : '我的收藏'}</a>
        </div>
      )}
    </>
  );
}
