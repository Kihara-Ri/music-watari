// iOS 式分段控件：滑块随选中项左右滑动。受控组件。
import {useLayoutEffect, useRef} from 'react';
import type {ReactNode} from 'react';

export interface SegOption {
  value: string;
  label: ReactNode;
  /** 选项内容为纯图标时提供可访问名称 */
  ariaLabel?: string;
}

export function Seg({options, value, onValue, className = '', ariaLabel}: {
  options: SegOption[]; value: string; onValue: (v: string) => void; className?: string; ariaLabel?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // 滑块定位：测量选中按钮的 offset；每次渲染与窗口缩放后重算
  useLayoutEffect(() => {
    const paint = () => {
      const sg = ref.current;
      if (!sg) return;
      const thumb = sg.querySelector<HTMLElement>('.seg-thumb');
      if (!thumb) return;
      const on = sg.querySelector<HTMLElement>('button.on');
      if (!on) { thumb.style.opacity = '0'; return; }
      // 首次落位不得滑入：读 offsetWidth 会先定下「宽0位0」的旧样式，随后的定位
      // 写入会触发 .18s 过渡，页面每次重挂载都重放一次指针滑入——先关过渡落定再恢复
      const fresh = !thumb.style.width;
      if (fresh) thumb.style.transition = 'none';
      thumb.style.opacity = '1';
      thumb.style.width = `${on.offsetWidth}px`;
      thumb.style.transform = `translateX(${on.offsetLeft}px)`;
      if (fresh) { void thumb.offsetWidth; thumb.style.transition = ''; }
    };
    paint();
    window.addEventListener('resize', paint);
    return () => window.removeEventListener('resize', paint);
  });

  return (
    <div className={`seg ${className}`.trim()} ref={ref} role="group" aria-label={ariaLabel}>
      <span className="seg-thumb" aria-hidden="true"/>
      {options.map(o => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''}
                aria-label={o.ariaLabel} onClick={() => onValue(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}
