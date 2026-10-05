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
import {GearIcon} from './components/ui/GearIcon';
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

// 手机页面切换的空间方向：rank 是页面在横向层级里的位置（底栏从左到右，
// 「更多」的子页比「更多」更深，回收站从设置进入）。进入更深的页面从右侧推入，
// 向左返回时当前页向右滑出；桌面与 prefers-reduced-motion 不做切换动画。
const PAGE_RANK: Record<string, number> = {
  domestic: 0, overseas: .5, transit: 1, shipping: 2,
  more: 3, ledger: 3.1, trades: 3.2, stats: 3.3, settings: 3.4, trash: 3.5,
};

export default function App() {
  const route = useHashRoute();
  const [state, setState] = useState<AppState | null>(null);
  const [fatal, setFatal] = useState('');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('new');
  const [flip, setFlip] = useState(false);
  const [tradeFilter, setTradeFilter] = useState('all');
  const [shelfFilter, setShelfFilter] = useState('all');
  const [shelfView, setShelfViewState] = useState<'list' | 'cards'>(() => {
    // 未手动切换过时按窗口宽度给默认：手机紧凑列表，桌面维持原卡片布局。
    const fallback = () => { try { return matchMedia('(max-width:840px)').matches ? 'list' : 'cards'; } catch { return 'list'; } };
    try {
      const v = localStorage.getItem('diedu-shelf-view') ?? localStorage.getItem('diedu-mobile-shelf-view');
      return v === 'list' || v === 'cards' ? v : fallback();
    } catch { return fallback(); }
  });
  const setShelfView = useCallback((v: 'list' | 'cards') => {
    setShelfViewState(v);
    try {
      localStorage.setItem('diedu-shelf-view', v);
      localStorage.removeItem('diedu-mobile-shelf-view'); // 旧键名仅限手机时留下，切换时迁移
    } catch { /* 浏览器不允许存储时仍可切换视图 */ }
  }, []);
  const [mobileSelecting, setMobileSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [theme, setThemeState] = useState<ThemePref>(() => themePref());
  const setTheme = useCallback((v: ThemePref) => { applyThemePref(v); setThemeState(v); }, []);
  const [drawer, setDrawer] = useState<DrawerSpec | null>(null);
  const [drawerClosing, setDrawerClosing] = useState(false);
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
    if (modules && page !== route) location.replace('#domestic');
  }, [modules, page, route]);

  // 环绕动画结束（onAnimationEnd）时由 Toast 自己通知消失；定时器只兜底
  const toast = useCallback((msg: string, kind: ToastKind = 'ok') => {
    setToastMsg(t => ({key: (t?.key ?? 0) + 1, kind, text: msg}));
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastMsg(null), 3000);
  }, []);

  // 回到页签时刷新：拾取其他设备/实例的改动，保持全量状态一致。
  // 30 秒内跳过重复拉取——页签频繁切换不应每次都全量下载状态。
  const lastRefreshAt = useRef(0);
  useEffect(() => {
    const onVis = () => {
      if (document.hidden || Date.now() - lastRefreshAt.current < 30000) return;
      lastRefreshAt.current = Date.now();
      refresh().catch(() => { /* 离线时静默 */ });
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [refresh]);

  // 关闭分两步：closeDrawer 只置 closing（Drawer 播完收回动画后回调 drawerExited 才真正卸载）
  // 每个抽屉会话在历史里压入同址条目：iOS 边缘右滑的「返回」先消费它，popstate 里
  // 把抽屉收回（脏表单先确认），而不是把路由退回上一个页面——所有上拉窗口统一行为。
  const drawerStack = useRef<DrawerSpec[]>([]);
  const drawerEntries = useRef(0);
  const popGuard = useRef(false);
  const openDrawer = useCallback((spec: DrawerSpec) => {
    drawerDirty.current = false;
    setDrawerClosing(false);
    setDrawer(spec);
    drawerStack.current.push(spec);
    history.pushState({diedu: 'drawer'}, '');
    drawerEntries.current++;
  }, []);

  const confirmDiscard = () => !drawerDirty.current || confirm('还没有保存，确定放弃这次修改吗？');

  const closeDrawer = useCallback((force = false): boolean => {
    if (!force && !confirmDiscard()) return false;
    drawerStack.current = []; // 收回动画期间到达的返回手势不再命中抽屉
    setDrawerClosing(true);
    return true;
  }, []);

  const drawerExited = useCallback(() => {
    setDrawer(null); setDrawerClosing(false);
    drawerStack.current = [];
    if (drawerEntries.current > 0) {
      popGuard.current = true;
      history.go(-drawerEntries.current);
      drawerEntries.current = 0;
    }
  }, []);

  useEffect(() => {
    const onPop = () => {
      if (popGuard.current) { popGuard.current = false; return; }
      const stack = drawerStack.current;
      if (!stack.length) {
        if (drawerEntries.current > 0) drawerEntries.current--; // 收回动画期间的手势先消费守卫条目
        return; // 无抽屉时的返回 = 正常路由后退，交给 hashchange
      }
      if (!confirmDiscard()) {
        history.pushState({diedu: 'drawer'}, ''); // 用户取消放弃：补回刚消费的守卫条目
        return;
      }
      stack.pop();
      drawerEntries.current = Math.max(0, drawerEntries.current - 1);
      if (stack.length) {
        // 艺人抽屉等往返场景：返回手势回到上一层抽屉（重挂载，与「返回」按钮同语义）
        drawerDirty.current = false;
        setDrawerClosing(false);
        setDrawer(stack[stack.length - 1]);
      } else {
        setDrawerClosing(true);
      }
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const setDrawerDirty = useCallback((v: boolean) => { drawerDirty.current = v; }, []);

  // 页面切换动画（样式见 styles/pagetransition.css）：旧页面以 DOM 快照参与滑出，
  // 组件不重复挂载。hashchange/popstate 在 React 重渲染前同步到达，监听里抢先
  // 抓整个 #main 的克隆（连内边距一起保住几何）；等 effect 跑起来时旧内容已被
  // 换掉，只能用这份快照。
  const mainRef = useRef<HTMLElement | null>(null);
  const prevPageRef = useRef(page);
  const ghostSnapRef = useRef<{el: HTMLElement; y: number} | null>(null);
  const lastHashRef = useRef(location.hash);
  const clickNavRef = useRef(0);
  const historyNavRef = useRef(false);
  useEffect(() => {
    const capture = () => {
      // 滚动偏移必须此刻记下：换页后内容变矮会被视口钳到 0，快照就对不上用户看到的位置了
      ghostSnapRef.current = mainRef.current
        ? {el: mainRef.current.cloneNode(true) as HTMLElement, y: window.scrollY}
        : null;
    };
    // 真正的历史遍历（iOS 边缘右滑、后退/前进）系统自带过渡画面，自己再播一遍
    // 就是双重动画——标记后由切页 effect 跳过。**WebKit 对锚点点击的 fragment
    // 导航也会连发两次 popstate**（实测序列 pop、pop、hash，与历史返回无法从
    // 事件本身区分），只能靠点击时间窗判别：点击后瞬间的 popstate 是应用内导航。
    const onPop = () => {
      if (location.hash !== lastHashRef.current && Date.now() - clickNavRef.current > 500) {
        historyNavRef.current = true;
      }
      capture();
    };
    const onHash = () => {
      lastHashRef.current = location.hash;
      capture();
    };
    const onClick = () => { clickNavRef.current = Date.now(); };
    document.addEventListener('click', onClick, true);
    window.addEventListener('popstate', onPop);
    window.addEventListener('hashchange', onHash);
    return () => {
      document.removeEventListener('click', onClick, true);
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('hashchange', onHash);
    };
  }, []);
  useEffect(() => {
    const prev = prevPageRef.current;
    prevPageRef.current = page;
    const main = mainRef.current;
    if (prev === page || !main) { ghostSnapRef.current = null; return; }
    const snap = ghostSnapRef.current;
    ghostSnapRef.current = null;
    // 历史驱动的换页（边缘右滑/后退键）交给系统过渡，自己不再播动画
    const fromHistory = historyNavRef.current;
    historyNavRef.current = false;
    let mobile = false;
    let animate = true;
    try {
      mobile = matchMedia('(max-width:840px)').matches;
      animate = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch { animate = false; }
    if (!snap || !mobile || !animate || fromHistory) return;
    const dir: 1 | -1 = (PAGE_RANK[page] ?? 3.5) >= (PAGE_RANK[prev] ?? 3.5) ? 1 : -1;
    // 快照可能取自上一场过渡进行中，先剥掉入场类再挂滑出类
    snap.el.classList.remove('page-in-right', 'page-in-left');
    snap.el.classList.add(dir === 1 ? 'page-out-left' : 'page-out-right');
    // 快照不随窗口滚动：按抓取时的滚动偏移还原，吸顶页头停在用户此刻看到的位置
    snap.el.querySelectorAll<HTMLElement>('.page-head').forEach(h => {
      h.style.transform = `translateY(${snap.y}px)`;
    });
    const ghost = document.createElement('div');
    ghost.className = dir === 1 ? 'page-ghost page-ghost-under' : 'page-ghost page-ghost-over';
    ghost.setAttribute('aria-hidden', 'true');
    const shifter = document.createElement('div');
    shifter.className = 'page-ghost-shift';
    shifter.style.transform = `translateY(${-snap.y}px)`;
    shifter.appendChild(snap.el);
    ghost.appendChild(shifter);
    document.body.appendChild(ghost);
    // 新页面同样补页头偏移：transform 会让 sticky 失效，补齐后动画首尾位置一致
    const heads = Array.from(main.querySelectorAll<HTMLElement>('.page-head'));
    heads.forEach(h => { h.style.transform = `translateY(${window.scrollY}px)`; });
    main.classList.add(dir === 1 ? 'page-in-right' : 'page-in-left');
    document.documentElement.classList.add('page-anim-lock');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      ghost.remove();
      main.classList.remove('page-in-right', 'page-in-left');
      heads.forEach(h => { h.style.transform = ''; });
      document.documentElement.classList.remove('page-anim-lock');
    };
    const timer = window.setTimeout(finish, 450); // 收不到 animationend（如中途关动画）时兜底
    const onEnd = (e: AnimationEvent) => {
      // 子元素自带的入场动画也会冒泡上来，只认两层盒子自身的动画
      if (e.target === main || e.target === snap.el) finish();
    };
    main.addEventListener('animationend', onEnd);
    ghost.addEventListener('animationend', onEnd);
    return () => {
      window.clearTimeout(timer);
      main.removeEventListener('animationend', onEnd);
      ghost.removeEventListener('animationend', onEnd);
      finish(); // 快速连切：立刻收掉上一场过渡
    };
  }, [page]);

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
    shelfView, setShelfView, mobileSelecting, setMobileSelecting,
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

  // 底栏滑动高亮：胶囊按激活槽位平移；「更多」固定在最后一位
  const activeTab = mobileTabs.findIndex(t => page === t.hash || (t.hash === 'domestic' && page === 'overseas'));
  const pillIndex = activeTab >= 0 ? activeTab : mobileTabs.length;

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
              <span className="nav-ico" aria-hidden="true"><GearIcon size={14}/></span>设置与备份
            </a>
            <div className="local-note"><i/> 数据保存在服务设备</div>
          </div>
        </aside>
        <main id="main" tabIndex={-1} ref={mainRef}><div className="page-layer">{content}</div></main>
      </div>
      {offline ? <div id="connection-status" role="status">网络已断开，保存前请恢复连接。</div> : null}
      <nav className="mobile-nav" aria-label="手机导航">
        <span className="nav-pill" aria-hidden="true" style={{
          width: `calc((100% - 12px) / ${mobileTabs.length + 1})`,
          transform: `translateX(${pillIndex * 100}%)`,
        }}/>
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
      {drawer ? <Drawer spec={drawer} closing={drawerClosing}
                        onClose={() => closeDrawer()} onClosed={drawerExited}/> : null}
      {toastMsg ? <Toast key={toastMsg.key} kind={toastMsg.kind} text={toastMsg.text} onDone={() => setToastMsg(null)}/> : null}
      <Lightbox/>
    </AppContext.Provider>
  );
}
