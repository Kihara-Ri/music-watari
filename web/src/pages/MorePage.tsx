import {useApp} from '../state/AppContext';
import {PageHead} from '../components/PageHead';
import {InstallNavItem} from '../components/InstallNavItem';
import {ThemeToggle} from '../components/ThemeToggle';
import {GearIcon} from '../components/ui/GearIcon';

export function MorePage({installEvt, onInstalled}: {installEvt: Event | null; onInstalled: () => void}) {
  const {modules, state} = useApp();
  const trades = state.sales.filter(s => s.status === 'complete').length;
  const ledgerDesc = modules.acquisition && modules.trading ? '查看在库、投入与已到账金额'
    : modules.acquisition ? '查看在库数量与投入成本'
      : modules.trading ? '查看在库数量与已到账金额' : '查看目前持有的专辑数量';
  return <>
    <PageHead title="更多" label="YOUR LEDGER"/>
    <div className="more-page">
      {modules.showcase ? <section aria-labelledby="more-gallery">
        <h2 id="more-gallery">展示收藏</h2>
        <nav aria-label="展示收藏">
          <a href="#gallery"><span className="nav-ico" aria-hidden="true">▦</span><span><strong>收藏展示</strong><small>九种封面排列，慢慢展示自己的收藏</small></span><span className="more-arrow" aria-hidden="true">›</span></a>
        </nav>
      </section> : null}
      <section aria-labelledby="more-records">
        <h2 id="more-records">账本与记录</h2>
        <nav aria-label="账本与记录">
          <a href="#ledger"><span className="nav-ico" aria-hidden="true">▧</span><span><strong>{modules.acquisition || modules.trading ? '账本概览' : '收藏概览'}</strong><small>{ledgerDesc}</small></span><span className="more-arrow" aria-hidden="true">›</span></a>
          {modules.trading ? <a href="#trades"><span className="nav-ico" aria-hidden="true">↗</span><span><strong>已交易</strong><small>已确认收货与到账的交易记录</small></span>{trades ? <b className="num">{trades}</b> : null}<span className="more-arrow" aria-hidden="true">›</span></a> : null}
          {modules.acquisition || modules.trading ? <a href="#stats"><span className="nav-ico" aria-hidden="true">◷</span><span><strong>{modules.trading ? '收支统计' : '购入统计'}</strong><small>{modules.trading ? modules.acquisition ? '按月查看买入与交易' : '按月查看交易与到账' : '按月查看购入与成本'}</small></span><span className="more-arrow" aria-hidden="true">›</span></a> : null}
        </nav>
      </section>
      <section aria-labelledby="more-manage">
        <h2 id="more-manage">管理</h2>
        <nav aria-label="管理入口">
          <a href="#settings"><span className="nav-ico" aria-hidden="true"><GearIcon size={19}/></span><span><strong>设置与备份</strong><small>功能组合、数据导出与恢复</small></span><span className="more-arrow" aria-hidden="true">›</span></a>
          <ThemeToggle withLabel/>
          {installEvt ? <InstallNavItem evt={installEvt} onInstalled={onInstalled}/> : null}
        </nav>
      </section>
      <div className="local-note"><i/> 数据保存在服务设备</div>
    </div>
  </>;
}
