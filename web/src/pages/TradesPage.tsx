import {openArtistDrawer} from '../forms/ArtistDrawer';
// 已交易页：搜索 + 状态筛选 + 完整销售单，利润按到账时间排序。
import {sum, yuan} from '../core/format';
import {searchScore} from '../core/search';
import {useApp} from '../state/AppContext';
import {PageHead} from '../components/PageHead';
import {SaleCard} from '../components/SaleCard';
import {Dropdown} from '../components/ui/Dropdown';
import {openSaleCostsForm} from '../forms/SaleCostsForm';

const TRADE_FILTERS = [
  {value: 'all', label: '全部'},
  {value: 'complete', label: '已售出'},
  {value: 'refunded', label: '已退款'},
  {value: 'returned', label: '已退货'},
];

export function TradesPage() {
  const app = useApp();
  const {state, modules, query, tradeFilter} = app;
  const q = query.toLowerCase().trim();
  let sales = state.sales.filter(s => ['complete', 'refunded', 'returned'].includes(s.status));
  if (tradeFilter !== 'all') sales = sales.filter(s => s.status === tradeFilter);
  sales = sales
    .filter(s => !q || s.items.some(i => {
      const r = app.rec(i.recordId);
      return !!r && searchScore(r, q) > 0;
    }))
    .sort((a, b) => (b.receivedDate || b.date).localeCompare(a.receivedDate || a.date));

  const all = state.sales.filter(s => s.status === 'complete');
  const items = all.flatMap(s => s.items);
  const ks = items.filter(i => i.profit !== null);

  return (
    <>
      <PageHead title="已交易" desc="买家已签收、钱款到账，落袋为安。" label="CASHED IN"
                actions={<a className="link-button" href="/api/export?scope=sales">导出 CSV</a>}/>
      <div className="summary">
        <span>已完成 <strong>{all.length}</strong> 笔</span>
        <span>到手 <strong>{yuan(sum(items, 'net'))}</strong></span>
        {modules.acquisition ? <span>利润 <strong className={sum(ks, 'profit') < 0 ? 'negative' : 'positive'}>{yuan(sum(ks, 'profit'))}</strong></span> : null}
        {modules.acquisition && items.length - ks.length ? <span className="hint">{items.length - ks.length} 条成本待补，未计入利润</span> : null}
      </div>
      <div className="toolbar">
        <div className="search">
          <input id="sale-search" aria-label="搜索交易" placeholder="搜索专辑、艺人或地址…"
                 value={query} onChange={e => app.setQuery(e.target.value)}/>
        </div>
        <Dropdown id="trade-filter" value={tradeFilter} options={TRADE_FILTERS}
                  label="交易状态" onPick={v => app.setTradeFilter(v)}/>
      </div>
      <div id="sales-list">
        {sales.length
          ? sales.map(s => <SaleCard key={s.id} s={s} onArtist={name => openArtistDrawer(app, name)} onEditCosts={() => openSaleCostsForm(app, s)}/>)
          : (
            <div className="empty">
              <div className="empty-symbol">↗</div>
              <h3>还没有已完成的交易</h3>
              <p>售出中的交易在买家签收、钱款到账后点「确认收货」，就会到这里。</p>
              <a className="link-button" href="#shipping">查看售出中</a>
            </div>
          )}
      </div>
    </>
  );
}
