// 收支统计页：核心指标块 + 按到账月份的交易表。
import {sum, yuan} from '../core/format';
import {useApp} from '../state/AppContext';
import {PageHead} from '../components/PageHead';

export function StatsPage() {
  const {state} = useApp();
  const ov = state.records.filter(r => r.status === 'overseas');
  const tr = state.records.filter(r => r.status === 'transit');
  const dom = state.records.filter(r => r.status === 'domestic');
  const shipping = state.sales.filter(s => s.status === 'shipping');
  const done = state.sales.filter(s => s.status === 'complete');
  const items = done.flatMap(s => s.items);
  const ks = items.filter(i => i.profit !== null);
  const profit = sum(ks, 'profit');

  const months: Record<string, {net: number; profit: number; count: number; unknown: number}> = {};
  done.forEach(s => {
    const k = (s.receivedDate || s.date).slice(0, 7);
    const m = months[k] ??= {net: 0, profit: 0, count: 0, unknown: 0};
    m.net += sum(s.items, 'net');
    m.profit += sum(s.items, 'profit');
    m.count += s.items.length;
    m.unknown += s.items.filter(i => i.profit === null).length;
  });

  const ovKnown = ov.filter(r => r.cost !== null);
  const domKnown = dom.filter(r => r.cost !== null);
  const ovListed = ov.filter(r => r.listed).length;
  const domListed = dom.filter(r => r.listed).length;

  return (
    <>
      <PageHead title="收支统计" desc="人民币统一口径：日元按购买当天汇率折算，运费均摊进成本。"
                label="IN NUMBERS"
                actions={<a className="link-button" href="/api/export">导出库存 CSV</a>}/>
      <div className="stat-grid">
        <div className="stat-block">
          <span className="stat-label">海外库存</span>
          <strong>{ov.length} 张</strong>
          <small>成本 {yuan(sum(ovKnown, 'cost'))}
            {ov.length - ovKnown.length ? ` · ${ov.length - ovKnown.length} 张待补` : ''}
            {ovListed ? ` · 已上架 ${ovListed} 张` : ''}</small>
        </div>
        <div className="stat-block">
          <span className="stat-label">海外在途</span>
          <strong>{tr.length} 张</strong>
          <small>{state.shipments.filter(s => s.status === 'transit').length} 个包裹 · 运费已计入成本 · 约 11 天</small>
        </div>
        <div className="stat-block">
          <span className="stat-label">国内库存价值</span>
          <strong>{yuan(sum(domKnown, 'cost'))}</strong>
          <small>{dom.length} 张{dom.length - domKnown.length ? ` · ${dom.length - domKnown.length} 张待补` : ''}
            {domListed ? ` · 已上架 ${domListed} 张` : ''}</small>
        </div>
        <div className="stat-block">
          <span className="stat-label">售出中应收</span>
          <strong>{yuan(sum(shipping.flatMap(s => s.items), 'net'))}</strong>
          <small>{shipping.length} 笔 · 确认收货后计入利润</small>
        </div>
        <div className="stat-block">
          <span className="stat-label">已实现利润</span>
          <strong className={profit < 0 ? 'negative' : 'positive'}>{yuan(profit)}</strong>
          <small>{ks.length} / {items.length} 条成本已知</small>
        </div>
      </div>
      <h3 className="section-title">月度交易</h3>
      <p className="help">按到账月份统计（确认收货）；退货归入处理月份。</p>
      <table className="monthly">
        <thead>
          <tr><th>月份</th><th>售出</th><th>到手</th><th>利润</th><th>成本待补</th></tr>
        </thead>
        <tbody>
          {Object.keys(months).sort().reverse().map(k => (
            <tr key={k}>
              <td>{k}</td>
              <td>{months[k].count} 张</td>
              <td>{yuan(months[k].net)}</td>
              <td className={months[k].profit < 0 ? 'negative' : 'positive'}>{yuan(months[k].profit)}</td>
              <td>{months[k].unknown ? `${months[k].unknown} 条` : '—'}</td>
            </tr>
          ))}
          {!Object.keys(months).length && <tr><td colSpan={5}>还没有已完成交易。</td></tr>}
        </tbody>
      </table>
    </>
  );
}
