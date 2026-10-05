// 抽屉面板：遮罩、焦点圈、Esc 关闭、离开时还原焦点。
// 手机上是底部 sheet：进入自屏底滑入；按住头部（抓手/标题区）下拉，松手超过阈值
// 或快速下滑即收回，否则回弹。未保存关闭会先弹确认（脏标记由表单经 AppCtx.setDrawerDirty 设置）。
import {useEffect, useRef} from 'react';
import type {DrawerSpec} from '../../state/AppContext';

const SHEET_QUERY = '(max-width:840px)';
// prefers-reduced-motion 下动画被全局禁用、收不到 animationend，用定时器兜底（动画最长 .28s）
const CLOSE_FALLBACK_MS = 400;

export function Drawer({spec, closing, onClose, onClosed}: {
  spec: DrawerSpec; closing: boolean;
  onClose: () => boolean;   // false = 脏表单的放弃确认被取消，抽屉保持打开
  onClosed: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const exitedRef = useRef(false);
  const dragRef = useRef<{startY: number; dy: number; v: number; lastY: number; lastT: number} | null>(null);
  const edgeActiveRef = useRef(false);

  const finishClose = () => {
    if (exitedRef.current) return;
    exitedRef.current = true;
    onClosed();
  };

  // 打开时：记住焦点、锁定背景、聚焦第一个输入
  useEffect(() => {
    const lastFocus = document.activeElement as HTMLElement | null;
    const shell = document.getElementById('shell');
    if (shell) shell.inert = true;
    const panel = panelRef.current;
    const target = panel?.querySelector<HTMLElement>('input:not([type=hidden]),select,textarea')
      || panel?.querySelector<HTMLElement>('[data-action=close]')
      || panel?.querySelector<HTMLElement>('.drawer-head button');
    target?.focus();
    return () => {
      if (shell) shell.inert = false;
      if (lastFocus?.isConnected) lastFocus.focus();
    };
  }, [spec]);

  // 收回动画兜底：reduced-motion 下 animationend 永远不来
  useEffect(() => {
    if (!closing) return;
    const t = window.setTimeout(finishClose, CLOSE_FALLBACK_MS);
    return () => window.clearTimeout(t);
  }, [closing]);

  // iOS 软键盘：WebKit 会把可视视口在布局视口内下移（visualViewport.offsetTop>0），
  // fixed 面板在屏幕上被整体顶出上缘。把 #panel 整层平移 offsetTop（背板随行，可视
  // 区域永远被盖住），sheet 在屏幕上保持原位、布局零变化——键盘只是叠在其下半部
  // 之上的一层；聚焦字段的露出交给 WebKit 对 drawer-body 的滚动露出。键盘收起
  // （offsetTop 归零）即还原。只在手机 sheet 断点生效：桌面捏合缩放也会动 offsetTop，
  // 不该拖着抽屉跑。
  // 同期锁定文档滚动（横竖都钉）：sheet 盖不住系统级滚动指示器；聚焦输入还会让
  // WebKit 滚动文档「露出」输入框，背景一动 Safari 底部地址栏就会重新展开盖住底部。
  // html overflow:hidden 挡不住 iOS 的这脚程序滚动，需把 scrollY 钉在开抽屉时的值。
  useEffect(() => {
    const vv = window.visualViewport;
    const panel = panelRef.current;
    if (!panel || !window.matchMedia(SHEET_QUERY).matches) return;
    const html = document.documentElement;
    html.style.overflow = 'hidden';
    const lockX = window.scrollX;
    const lockY = window.scrollY;
    const onScroll = () => {
      if (window.scrollX !== lockX || window.scrollY !== lockY) window.scrollTo(lockX, lockY);
    };
    window.addEventListener('scroll', onScroll, {passive: true});
    if (!vv) {
      return () => {
        window.removeEventListener('scroll', onScroll);
        html.style.overflow = '';
      };
    }
    const apply = () => {
      panel.style.transform = vv.offsetTop > 1 ? `translateY(${vv.offsetTop}px)` : '';
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      window.removeEventListener('scroll', onScroll);
      panel.style.transform = '';
      html.style.overflow = '';
    };
  }, [spec]);

  // —— 手机 sheet：屏幕左缘横向右滑 = 跟手下拉收起 ——
  // iOS 系统对边缘右滑的默认响应是整页侧向过渡（浏览器自己的返回动画），对上拉
  // sheet 毫无意义且收尾会闪。页面在 touchmove 上 preventDefault 可令该系统手势
  // 中止（触摸流仍完整送达页面），于是把这段手势接管成「按住 sheet 往下拖」：
  // 横向位移 1:1 映射为下拉位移，松手超过阈值或快速下滑即收回，否则回弹；纵向
  // 滑动不拦截，放行给 drawer-body 原生滚动。桌面断点不接管。
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    let start: {x: number; y: number} | null = null;
    let active = false;
    let dx = 0, v = 0, lastX = 0, lastT = 0;
    const springBack = () => {
      sheet.style.transition = 'transform .26s cubic-bezier(.2,.8,.3,1)';
      sheet.style.transform = '';
    };
    const onStart = (e: TouchEvent) => {
      if (closing || dragRef.current || edgeActiveRef.current) return;
      if (!window.matchMedia(SHEET_QUERY).matches) return;
      const t = e.touches[0];
      if (t.clientX > 28) return;
      // 手起点落在 sheet 内部横向滚动条带上（如封面候选）时让位给原生横向滚动
      let node: Element | null = e.target instanceof Element ? e.target : null;
      while (node && node !== sheet) {
        if (node.scrollWidth > node.clientWidth + 1) return;
        node = node.parentElement;
      }
      // 键盘弹出时 WebKit 会把横向手势整流收归系统（页面收不到 touchmove），
      // 先同步收起键盘：键盘落下后触摸流回到页面，本次滑动继续作为下拉接管
      const focused = document.activeElement;
      if (focused instanceof HTMLElement && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) focused.blur();
      start = {x: t.clientX, y: t.clientY};
      active = false; dx = 0; v = 0; lastX = t.clientX; lastT = e.timeStamp;
    };
    const onMove = (e: TouchEvent) => {
      if (!start) return;
      if (e.touches.length > 1) {  // 捏合等多指手势不接管
        start = null;
        if (active) { active = false; edgeActiveRef.current = false; springBack(); }
        return;
      }
      const t = e.touches[0];
      const ddx = t.clientX - start.x;
      const ddy = t.clientY - start.y;
      if (!active) {
        if (Math.abs(ddx) < 8 && Math.abs(ddy) < 8) return;
        if (ddx <= 0 || Math.abs(ddx) <= Math.abs(ddy)) { start = null; return; }
        active = true;
        edgeActiveRef.current = true;
        sheet.style.transition = 'none';
      }
      e.preventDefault();  // 中止系统边缘侧滑与页面滚动，本次触摸交给 sheet 拖拽
      dx = Math.max(0, ddx);
      const dt = e.timeStamp - lastT;
      if (dt > 0) { v = (t.clientX - lastX) / dt; lastX = t.clientX; lastT = e.timeStamp; }
      sheet.style.transform = `translateY(${dx}px)`;
    };
    const onEnd = () => {
      if (!start) return;
      start = null;
      if (!active) return;
      active = false;
      edgeActiveRef.current = false;
      const fling = dx > 40 && v > 0.55;
      const far = dx > Math.max(110, sheet.offsetHeight * 0.22);
      if ((fling || far) && onClose()) {
        // closing 类接管：隐式动画起点 = 当前内联位移，继续滑向屏底
      } else {
        springBack();
      }
    };
    // touchstart 必须 capture：iOS 键盘弹出时 WebKit 只把 touchstart 派发到捕获阶段
    // （冒泡阶段收不到，实测），而收键盘、记录手势起点都依赖它。
    document.addEventListener('touchstart', onStart, {passive: true, capture: true});
    document.addEventListener('touchmove', onMove, {passive: false});
    document.addEventListener('touchend', onEnd, {passive: true});
    document.addEventListener('touchcancel', onEnd, {passive: true});
    return () => {
      document.removeEventListener('touchstart', onStart, true);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      document.removeEventListener('touchcancel', onEnd);
    };
  }, [closing, onClose, spec]);

  const requestClose = () => { if (!closing) onClose(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
    if (e.key === 'Tab') {
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]),input:not([disabled]),select,textarea,a[href]',
      )].filter(el => el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  };

  // 收回动画结束（手机 sheet-down / 桌面 drawer-out）才真正卸载
  const onAnimationEnd = (e: React.AnimationEvent) => {
    if (closing && (e.animationName === 'sheet-down' || e.animationName === 'drawer-out')) finishClose();
  };

  // —— 手机 sheet：按住头部跟手下拉 ——
  const onHeadPointerDown = (e: React.PointerEvent) => {
    if (spec.variant === 'artist' || closing || dragRef.current || edgeActiveRef.current || !window.matchMedia(SHEET_QUERY).matches) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    if (!sheetRef.current) return;
    dragRef.current = {startY: e.clientY, dy: 0, v: 0, lastY: e.clientY, lastT: e.timeStamp};
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件无活动指针，忽略 */ }
  };

  const onHeadPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const sheet = sheetRef.current;
    if (!d || !sheet) return;
    d.dy = Math.max(0, e.clientY - d.startY);
    const dt = e.timeStamp - d.lastT;
    if (dt > 0) { d.v = (e.clientY - d.lastY) / dt; d.lastY = e.clientY; d.lastT = e.timeStamp; }
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${d.dy}px)`;
  };

  const endHeadDrag = () => {
    const d = dragRef.current;
    const sheet = sheetRef.current;
    dragRef.current = null;
    if (!d || !sheet) return;
    const fling = d.dy > 40 && d.v > 0.55;
    const far = d.dy > Math.max(110, sheet.offsetHeight * 0.22);
    if ((fling || far) && onClose()) {
      // closing 类接管：隐式动画起点 = 当前内联位移，继续滑向屏底
    } else {
      sheet.style.transition = 'transform .26s cubic-bezier(.2,.8,.3,1)';
      sheet.style.transform = '';
    }
  };

  return (
    <div id="panel" ref={panelRef} onKeyDown={onKeyDown}
         onClick={e => { if (e.target === e.currentTarget) requestClose(); }}>
      <section ref={sheetRef} onAnimationEnd={onAnimationEnd}
               className={`drawer${spec.wide ? ' wide' : ''}${spec.variant === 'artist' ? ' artist-drawer' : ''}${spec.workspace ? ' import-workspace' : ''}${closing ? ' closing' : ''}`}
               role="dialog" aria-modal="true" aria-labelledby="drawer-title">
        <div className="drawer-head" onPointerDown={onHeadPointerDown} onPointerMove={onHeadPointerMove}
             onPointerUp={endHeadDrag} onPointerCancel={endHeadDrag}>
          {spec.variant === 'artist' ? <button type="button" className="quiet artist-back"
            onClick={spec.back ? spec.back.run : requestClose} aria-label={spec.back?.label || '返回'}>← <span>{spec.back?.label || '返回'}</span></button> : null}
          <h2 id="drawer-title">{spec.title}</h2>
          <button type="button" className="quiet" data-action="close" onClick={requestClose} aria-label="关闭">×</button>
        </div>
        {spec.asForm ? spec.content : <div className="drawer-body">{spec.content}</div>}
        {!spec.asForm && (spec.footer || spec.variant === 'artist') ? <div className={`drawer-footer${spec.variant === 'artist' ? ' artist-footer' : ''}`}>{spec.footer}</div> : null}
      </section>
    </div>
  );
}
