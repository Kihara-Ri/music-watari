// 售出中页：专辑卡（预计到手/预估利润）+ 销售单操作条（整单确认）。
import {sum, yuan} from '../core/format';
import {useApp} from '../state/AppContext';
import {PageHead} from '../components/PageHead';
import {ShippingCard, ShippingBar} from '../components/SaleCard';
import {CardGrid} from '../components/Cards';

export function ShippingPage() {
  const {state} = useApp();
  const rs = state.records.filter(r => r.status === 'shipping');
  const sales = state.sales.filter(s => s.status === 'shipping');
  const items = sales.flatMap(s => s.items);
  const ks = items.filter(i => i.profit !== null);

  return (
    <>
      <PageHead title="售出中"
                desc="已卖出、包裹在途。买家签收且钱款到账后，在下方销售单点「确认收货」转为已交易。"/>
      <div className="summary">
        <span><strong>{rs.length}</strong> 张专辑</span>
        <span><strong>{sales.length}</strong> 个销售单</span>
        <span>预计到手 <strong>{yuan(sum(items, 'net'))}</strong></span>
        <span>预估利润 <strong className={sum(ks, 'profit') < 0 ? 'negative' : 'positive'}>
          {ks.length ? yuan(sum(ks, 'profit')) : '—'}
        </strong></span>
        {items.length - ks.length ? <span className="hint">{items.length - ks.length} 条成本待补</span> : null}
      </div>
      {rs.length ? (
        <CardGrid records={rs} renderCard={r => <ShippingCard key={r.id} r={r}/>}/>
      ) : (
        <div className="empty">
          <div className="empty-symbol">◨</div>
          <h3>没有售出中的专辑</h3>
          <p>在国内库存点击「记录售出」后，专辑会在这里等待买家签收。</p>
          <a className="link-button" href="#domestic">查看国内库存</a>
        </div>
      )}
      {sales.length ? (
        <>
          <div className="section-sub">销售单操作 · 整单确认</div>
          {sales.map(s => <ShippingBar key={s.id} s={s}/>)}
        </>
      ) : null}
    </>
  );
}
