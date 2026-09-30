// 全局消息提示：顶部中间弹出，一条彩线从顶边中点出发沿边框环绕一周，
// 走过的路径变为对应级别的颜色，走完一圈回到起点即消失（由动画结束事件驱动，
// App.tsx 的定时器只作兜底）。级别：ok 绿 / warn 黄 / err 红。
import {useLayoutEffect, useRef, useState} from 'react';
import type {ToastKind} from '../../state/AppContext';

const RADIUS = 14;   // 与 #toast 的 border-radius 保持一致
const INSET = 1.25;  // 描边宽 2.5，路径内缩一半让线正好压住 1px 边框

// 圆角矩形路径，起笔在顶边中点、顺时针绕行回到起点——
// 不用 <rect>：rect 的描边起笔在左上圆弧后，dash 在闭合路径上不绕回，
// 起点左侧那段永远补不上。pathLength=100 后 dasharray 0→100 即整圈。
function ringPath(width: number, height: number): string {
  const i = INSET, x = i, y = i, w = width - i * 2, h = height - i * 2;
  const r = Math.min(RADIUS, w / 2, h / 2);
  const cx = x + w / 2;
  return 'M ' + cx + ' ' + y
    + ` H ${x + w - r} A ${r} ${r} 0 0 1 ${x + w} ${y + r}`
    + ` V ${y + h - r} A ${r} ${r} 0 0 1 ${x + w - r} ${y + h}`
    + ` H ${x + r} A ${r} ${r} 0 0 1 ${x} ${y + h - r}`
    + ` V ${y + r} A ${r} ${r} 0 0 1 ${x + r} ${y}`
    + ` H ${cx}`;
}

export function Toast({kind, text, onDone}: {kind: ToastKind; text: string; onDone: () => void}) {
  const box = useRef<HTMLDivElement>(null);
  const [d, setD] = useState('');
  const [leaving, setLeaving] = useState(false);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !el.clientWidth) return;
    setD(ringPath(el.clientWidth, el.clientHeight));
  }, [text]);

  return (
    <div id="toast" className={kind + (leaving ? ' leaving' : '')} ref={box} role="status" aria-live="polite"
         onAnimationEnd={e => {
           // 环走满 → 进入退场（停留片刻后淡出）；退场结束 → 移除
           if (e.animationName === 'toast-ring') setLeaving(true);
           else if (e.animationName === 'toast-out') onDone();
         }}>
      <svg className="toast-ring" aria-hidden="true">
        {d ? <path d={d} pathLength="100"/> : null}
      </svg>
      {text}
    </div>
  );
}
