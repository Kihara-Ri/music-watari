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
  // fixed 面板随之整体被顶出屏幕上方（只剩底部贴着键盘）。把面板锚定到可视视口
  // 矩形，sheet 连头带底完整落在键盘上方；键盘收起（offsetTop 归零）即还原。
  // 同期锁定文档滚动：sheet 盖不住系统级滚动指示器；聚焦输入还会让 WebKit 上滚
  // 文档「露出」输入框，背景一动 Safari 底部地址栏就会重新展开、盖住 sheet 底部。
  // html overflow:hidden 挡不住 iOS 的这脚程序滚动，需把 scrollY 钉在开抽屉时的值。
  useEffect(() => {
    const vv = window.visualViewport;
    const panel = panelRef.current;
    if (!panel) return;
    const html = document.documentElement;
    html.style.overflow = 'hidden';
    const lockY = window.scrollY;
    const onScroll = () => { if (window.scrollY !== lockY) window.scrollTo(0, lockY); };
    window.addEventListener('scroll', onScroll, {passive: true});
    if (!vv) {
      return () => {
        window.removeEventListener('scroll', onScroll);
        html.style.overflow = '';
      };
    }
    const apply = () => {
      if (vv.offsetTop > 1) {
        panel.style.top = `${vv.offsetTop}px`;
        panel.style.height = `${vv.height}px`;
        panel.style.bottom = 'auto';
      } else {
        panel.style.top = '';
        panel.style.height = '';
        panel.style.bottom = '';
      }
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      window.removeEventListener('scroll', onScroll);
      panel.style.top = '';
      panel.style.height = '';
      panel.style.bottom = '';
      html.style.overflow = '';
    };
  }, [spec]);

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
    if (spec.variant === 'artist' || closing || dragRef.current || !window.matchMedia(SHEET_QUERY).matches) return;
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
