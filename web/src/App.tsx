// 应用外壳：状态装配、hash 路由、抽屉/toast/PWA 效果、侧栏与页面分发。
import {useCallback, useEffect, useRef, useState} from 'react';
import {api, ApiError} from './core/api';
import {pageEnabled, PRESETS} from './core/modules';
import {applyThemePref, themePref} from './core/theme';
import type {ThemePref} from './core/theme';
import {useHashRoute} from './hooks/useHashRoute';
import {AppContext} from './state/AppContext';
import type {AppCtx, DrawerSpec} from './state/AppContext';
import type {AppState, SortMode} from './types';
import {Ledger} from './components/PageHead';
import {InstallNavItem} from './components/InstallNavItem';
import {Drawer} from './components/ui/Drawer';
import {Lightbox} from './components/ui/Lightbox';
import {Toast} from './components/ui/Toast';
import type {ToastKind} from './state/AppContext';
import {ShelfPage} from './pages/ShelfPage';
import {TransitPage} from './pages/TransitPage';
import {ShippingPage} from './pages/ShippingPage';
import {TradesPage} from './pages/TradesPage';
import {StatsPage} from './pages/StatsPage';
import {SettingsPage} from './pages/SettingsPage';
import {SetupPage} from './pages/SetupPage';
import {MorePage} from './pages/MorePage';
import {LedgerPage} from './pages/LedgerPage';

const NAV = [
  {hash: 'overseas', ico: '◧', label: '海外库存'},
  {hash: 'transit', ico: '✈', label: '海外在途'},
  {hash: 'domestic', ico: '▤', label: '国内库存'},
  {hash: 'shipping', ico: '◨', label: '售出中'},
  {hash: 'trades', ico: '↗', label: '已交易'},
  {hash: 'stats', ico: '◷', label: '收支统计'},
];

// 手机把国内 / 海外收进库存页；低频入口通过独立「更多」页访问。
const MOBILE_TABS = [
  {hash: 'domestic', ico: '▤', label: '库存', count: 'inventory'},
  {hash: 'transit', ico: '✈', label: '在途', count: 'transit'},
  {hash: 'shipping', ico: '◨', label: '售出中', count: 'shipping'},
] as const;

const MORE_HASHES = new Set(['more', 'ledger', 'trades', 'stats', 'settings', 'trash']);

export default function App() {
  const route = useHashRoute();
  const [state, setState] = useState<AppState | null>(null);
  const [fatal, setFatal] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('new');
  const [flip, setFlip] = useState(false);
  const [tradeFilter, setTradeFilter] = useState('all');
  const [shelfFilter, setShelfFilter] = useState('all');
  const [mobileShelfView, setMobileShelfView] = useState<'list' | 'cards'>(() => {
    try { return localStorage.getItem('diedu-mobile-shelf-view') === 'cards' ? 'cards' : 'list'; }
    catch { return 'list'; }
  });
  const [mobileSelecting, setMobileSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [theme, setThemeState] = useState<ThemePref>(() => themePref());
  const setTheme = useCallback((v: ThemePref) => { applyThemePref(v); setThemeState(v); }, []);
  const [drawer, setDrawer] = useState<DrawerSpec | null>(null);
  const drawerDirty = useRef(false);
  const [toastMsg, setToastMsg] = useState<{key: number; kind: ToastKind; text: string} | null>(null);
  const toastTimer = useRef(0);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [installEvt, setInstallEvt] = useState<Event | null>(null);
  const [inventoryPage, setInventoryPage] = useState('domestic');
  const modules = state?.modules?.needsSetup ? PRESETS[0].enabled : state?.modules?.enabled ?? (state ? PRESETS[3].enabled : undefined);
  const page = modules && !pageEnabled(route, modules) ? 'domestic' : route;

  const refresh = useCallback(async () => { setState(await api<AppState>('state')); }, []);

  // 首次加载：401 → 登录页；失败 → 重试界面
  useEffect(() => {
    refresh().catch(e => {
      if (e instanceof ApiError && e.status === 401) { location.replace('/login'); return; }
      setFatal(e instanceof Error ? e.message : String(e));
    });
  }, [refresh]);

  // 换页重置选择与筛选，并记住手机库存的地区。
  useEffect(() => {
    setSelected(new Set());
    setQuery('');
    setSort('new');
    setShelfFilter('all');
    setMobileSelecting(false);
    if (page === 'domestic' || page === 'overseas') setInventoryPage(page);
  }, [page, modules?.acquisition, modules?.trading, modules?.circulation]);

  useEffect(() => {
    try { localStorage.setItem('diedu-mobile-shelf-view', mobileShelfView); }
    catch { /* 浏览器不允许存储时仍可切换视图 */ }
  }, [mobileShelfView]);

  useEffect(() => {
    if (modules && page !== route) location.replace('#domestic');
  }, [modules, page, route]);

  // 环绕动画结束（onAnimationEnd）时由 Toast 自己通知消失；定时器只兜底
  const toast = useCallback((msg: string, kind: ToastKind = 'ok') => {
    setToastMsg(t => ({key: (t?.key ?? 0) + 1, kind, text: msg}));
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 3000);
  }, []);

  // 回到页签时刷新：拾取书签从 RYM 回传的艺人绑定，并提示新增绑定
  const seenRym = useRef<Set<string> | null>(null);
  useEffect(() => {
    const links = state?.settings?.['rym-links'] as Record<string, string> | undefined;
    if (!links) return;
    const names = new Set(Object.keys(links));
    if (seenRym.current) {
      const fresh = [...names].filter(n => !seenRym.current!.has(n));
      if (fresh.length) toast(fresh.length === 1 ? `已绑定 RYM 艺人：${fresh[0]}` : `已绑定 ${fresh.length} 个 RYM 艺人链接`);
    }
    seenRym.current = names;
  }, [state, toast]);

  useEffect(() => {
    const onVis = () => { if (!document.hidden) refresh().catch(() => { /* 离线时静默 */ }); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  const openDrawer = useCallback((spec: DrawerSpec) => {
    drawerDirty.current = false;
    setDrawer(spec);
  }, []);

  const closeDrawer = useCallback((force = false) => {
    if (!force && drawerDirty.current && !confirm('还没有保存，确定放弃这次修改吗？')) return;
    setDrawer(null);
  }, []);

  const setDrawerDirty = useCallback((v: boolean) => { drawerDirty.current = v; }, []);

  // PWA：注册 Service Worker、离线横幅、侧栏安装入口
  useEffect(() => {
    navigator.serviceWorker?.register('/sw.js').catch(() => { /* 离线壳不可用不影响使用 */ });
    const on = () => setOffline(false);
    const off = () => setOffline(true);
    const bip = (e: Event) => { e.preventDefault(); setInstallEvt(e); };
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    window.addEventListener('beforeinstallprompt', bip);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
      window.removeEventListener('beforeinstallprompt', bip);
    };
  }, []);

  if (!state || !modules) {
    if (fatal) {
      return (
        <div className="empty">
          <h2>暂时无法打开碟渡</h2>
          <p>{fatal}</p>
          <button onClick={() => location.reload()}>重新连接</button>
        </div>
      );
    }
    return (
      <div className="loading">
        <div className="vinyl vinyl-small" aria-hidden="true"><i className="vinyl-hole"/></div>
        <p>加载中</p>
      </div>
    );
  }

  const ctx: AppCtx = {
    state, modules, page,
    query, setQuery,
    sort, setSort,
    flip, setFlip,
    tradeFilter, setTradeFilter,
    shelfFilter, setShelfFilter,
    mobileShelfView, setMobileShelfView, mobileSelecting, setMobileSelecting,
    selected, setSelected,
    theme, setTheme,
    rec: id => state.records.find(r => r.id === id),
    refresh, toast,
    openDrawer, closeDrawer, setDrawerDirty,
  };

  const counts: Record<string, number> = {
    overseas: 0, transit: 0, domestic: 0, shipping: 0, trades: 0,
  };
  state.records.forEach(r => { if (r.status in counts) counts[r.status]++; });
  counts.trades = state.sales.filter(s => s.status === 'complete').length;
  if (!modules.circulation) counts.domestic += counts.overseas + counts.transit;
  counts.inventory = counts.domestic + (modules.circulation ? counts.overseas : 0);
  const nav = NAV.filter(n => pageEnabled(n.hash, modules)).map(n => ({...n,
    label: n.hash === 'domestic' && !modules.circulation ? '我的收藏' : n.hash === 'stats' && !modules.trading ? '购入统计' : n.label,
  }));
  const mobileTabs = MOBILE_TABS.filter(n => pageEnabled(n.hash, modules)).map(n => ({...n,
    label: n.hash === 'domestic' && !modules.circulation ? '收藏' : n.label,
  }));
  const content = state.modules?.needsSetup ? <SetupPage/>
    : ['overseas', 'domestic', 'trash'].includes(page) ? <ShelfPage/>
    : page === 'transit' ? <TransitPage/>
      : page === 'shipping' ? <ShippingPage/>
        : page === 'trades' ? <TradesPage/>
          : page === 'stats' ? <StatsPage/>
            : page === 'more' ? <MorePage installEvt={installEvt} onInstalled={() => setInstallEvt(null)}/>
              : page === 'ledger' ? <LedgerPage/>
                : <SettingsPage/>;

  return (
    <AppContext.Provider value={ctx}>
      <a className="skip" href="#main">跳至内容</a>
      <div id="shell">
        <aside className="sidebar">
          <a className="brand" href="#domestic">
            <img className="brand-logo" src="/icon-192.png" alt="" width="30" height="30"/>
            <span>碟渡<small>{modules.circulation ? '藏 · 渡 · 售' : modules.trading ? '藏 · 售' : '记住每张唱片'}</small></span>
          </a>
          <nav aria-label="主导航">
            {nav.map(n => (
              <a key={n.hash} href={`#${n.hash}`} data-nav={n.hash}
                 className={page === n.hash ? 'active' : ''}
                 aria-current={page === n.hash ? 'page' : 'false'}>
                <span className="nav-ico">{n.ico}</span>{n.label}
                {n.hash !== 'stats' ? <b id={`${n.hash}-count`}>{counts[n.hash]}</b> : null}
              </a>
            ))}
          </nav>
          <div className="sidebar-bottom">
            {installEvt ? <InstallNavItem evt={installEvt} onInstalled={() => setInstallEvt(null)}/> : null}
            <Ledger/>
            <a href="#settings" data-nav="settings"
               className={page === 'settings' ? 'active' : ''}>
              <span className="nav-ico">⚙</span>设置与备份
            </a>
            <div className="local-note"><i/> 数据保存在服务设备</div>
          </div>
        </aside>
        <main id="main" tabIndex={-1}>{content}</main>
      </div>
      {offline ? <div id="connection-status" role="status">网络已断开，保存前请恢复连接。</div> : null}
      <nav className="mobile-nav" aria-label="手机导航">
        {mobileTabs.map(t => (
          <a key={t.hash} href={`#${t.hash === 'domestic' && modules.circulation ? inventoryPage : t.hash}`}
             className={page === t.hash || (t.hash === 'domestic' && page === 'overseas') ? 'active' : ''}
             aria-current={page === t.hash || (t.hash === 'domestic' && page === 'overseas') ? 'page' : 'false'}>
            <span className="tab-ico" aria-hidden="true">{t.ico}</span>
            <span className="tab-label">{t.label}</span>
            {counts[t.count] ? <b className="tab-badge num">{counts[t.count]}</b> : null}
          </a>
        ))}
        <a href="#more" className={MORE_HASHES.has(page) ? 'active' : ''}
           aria-current={MORE_HASHES.has(page) ? 'page' : 'false'}>
          <span className="tab-ico" aria-hidden="true">⋯</span>
          <span className="tab-label">更多</span>
        </a>
      </nav>
      {drawer ? <Drawer spec={drawer} onClose={() => closeDrawer()}/> : null}
      {toastMsg ? <Toast key={toastMsg.key} kind={toastMsg.kind} text={toastMsg.text} onDone={() => setToastMsg(null)}/> : null}
      <Lightbox/>
    </AppContext.Provider>
  );
}
