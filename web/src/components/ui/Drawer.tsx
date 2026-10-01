// 抽屉面板：遮罩、焦点圈、Esc 关闭、离开时还原焦点。
// 未保存关闭会弹确认（脏标记由表单经 AppCtx.setDrawerDirty 设置）。
import {useEffect, useRef} from 'react';
import type {DrawerSpec} from '../../state/AppContext';

export function Drawer({spec, onClose}: {spec: DrawerSpec; onClose: () => void}) {
  const panelRef = useRef<HTMLDivElement>(null);

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
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return; }
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

  return (
    <div id="panel" ref={panelRef} onKeyDown={onKeyDown}
         onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <section className={`drawer${spec.wide ? ' wide' : ''}${spec.workspace ? ' import-workspace' : ''}`} role="dialog" aria-modal="true"
               aria-labelledby="drawer-title">
        <div className="drawer-head">
          <h2 id="drawer-title">{spec.title}</h2>
          <button type="button" className="quiet" data-action="close" onClick={onClose} aria-label="关闭">×</button>
        </div>
        {spec.asForm ? spec.content : <div className="drawer-body">{spec.content}</div>}
        {!spec.asForm && spec.footer ? <div className="drawer-footer">{spec.footer}</div> : null}
      </section>
    </div>
  );
}
