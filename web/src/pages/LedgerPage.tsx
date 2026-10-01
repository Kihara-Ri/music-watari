import {useApp} from '../state/AppContext';
import {Ledger, PageHead} from '../components/PageHead';

export function LedgerPage() {
  const {modules} = useApp();
  return <>
    <PageHead title={modules.acquisition || modules.trading ? '账本概览' : '收藏概览'} label="LEDGER"
      actions={<a className="link-button" href="#more">返回更多</a>}/>
    <div className="ledger-page">
      <Ledger mode="page"/>
      {modules.acquisition && modules.trading ? <p className="small-note">售出金额只计已确认到账的交易；已实现利润只计其中成本已知的明细。</p> : modules.trading ? <p className="small-note">售出金额只计已确认到账的交易。</p> : null}
    </div>
  </>;
}
