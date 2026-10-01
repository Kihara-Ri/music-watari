// 页头（标题 / 描述 / 动作区）与侧栏账本。
import type {ReactNode} from 'react';
import {useApp} from '../state/AppContext';
import {sum, yuan} from '../core/format';

export function PageHead({title, desc, actions, label}: {
  title: ReactNode; desc?: ReactNode; actions?: ReactNode; label?: string;
}) {
  return (
    <header className="page-head">
      <div>
        {label ? <div className="eyebrow">{label}</div> : null}
        <h1>{title}</h1>
        {desc ? <p>{desc}</p> : null}
      </div>
      {actions ? <div className="head-actions">{actions}</div> : null}
    </header>
  );
}

// 侧栏账本：口径与统计页一致（已实现利润只计成本已知的已完成交易）
export function Ledger({mode = 'sidebar'}: {mode?: 'sidebar' | 'page'}) {
  const {state, modules} = useApp();
  const inv = state.records.filter(r => ['overseas', 'transit', 'domestic'].includes(r.status));
  const known = inv.filter(r => r.cost !== null);
  const ks = state.sales.filter(s => s.status === 'complete').flatMap(s => s.items).filter(i => i.profit !== null);
  const profit = sum(ks, 'profit');
  const sold = sum(state.sales.filter(s => s.status === 'complete').flatMap(s => s.items), 'net');
  const unknownCount = inv.length - known.length;
  return (
    <div className={mode === 'page' ? 'ledger-summary' : 'side-ledger'} aria-label="账本概览">
      {mode === 'sidebar' ? <div className="sl-title">{modules.acquisition || modules.trading ? '账本' : '收藏'}</div> : null}
      <div className="sl-row"><span>在库</span><b>{inv.length} 张</b></div>
      {modules.acquisition ? <div className="sl-row">
        <span>投入成本</span>
        <b>
          {known.length ? yuan(sum(known, 'cost')) : '—'}
          {unknownCount ? <i className="hint"> {unknownCount} 待补</i> : null}
        </b>
      </div> : null}
      {modules.trading ? <div className="sl-row">
        <span>售出金额</span>
        <b>{yuan(sold)}</b>
      </div> : null}
      {modules.trading && modules.acquisition ? <div className="sl-row">
        <span>已实现利润</span>
        <b className={profit < 0 ? 'negative' : 'positive'}>{yuan(profit)}</b>
      </div> : null}
    </div>
  );
}
