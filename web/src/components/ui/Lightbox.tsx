// 实物照片灯箱：监听全局点击（表单缩略图 / 详情照片墙 / 识别导入）打开。
// 同一容器内的照片排在滑动轨道上连续翻看：触屏跟手拖动，松手沿用展示板块的
// 惯性物理（core/gallery-motion 的滑行 + 临界阻尼对齐），邻张随轨道提前挂载，
// 不再有换图解码空窗；桌面另有左右按钮与方向键，连按会延展目标。
// 点背景或 Esc 关闭（Esc 只关灯箱这一层）。
import {useEffect, useRef, useState} from 'react';
import type {MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent} from 'react';
import {ChevLeftIco, ChevRightIco} from '../icons';
import {advanceGalleryMotion, clampGalleryPosition, galleryReleaseVelocity, releaseGalleryMotion} from '../../core/gallery-motion';
import type {GalleryMotionState} from '../../core/gallery-motion';

type View = {list: string[]; pos: number};
// rail = 展示板块的滑行/对齐状态；rubber = 两端外拖的回弹（rail 入口会钳制位置，回弹须在钳制外走）
type Motion = {kind: 'rail'; state: GalleryMotionState} | {kind: 'rubber'; target: number};

const RUBBER = 0.3;     // 两端再往外拖的阻尼比例
const SETTLE_RATE = 14; // 与 gallery-motion 相同的临界阻尼速率（每秒）

export function Lightbox() {
  const [view, setView] = useState<View | null>(null);
  // 翻页进行中按钮跟目标位置走（同 useGalleryMotion 的 navigationTarget）：
  // round(pos) 会先一步抵达边界把按钮拆掉，快速连按就没法延展目标了。
  const [navTarget, setNavTarget] = useState<number | null>(null);
  const latest = useRef({view});
  latest.current = {view};
  const posRef = useRef(0);
  const motion = useRef<Motion | null>(null);
  const frame = useRef(0);
  const lastAt = useRef(0);
  const gesture = useRef<{id: number; x: number; y: number; start: number; moved: boolean;
    axis: '' | 'x' | 'y'; samples: Array<{position: number; at: number}>} | null>(null);
  const trailingClick = useRef(false);
  const reduced = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const apply = (pos: number) => {
    posRef.current = pos;
    setView(prev => prev ? {...prev, pos} : prev);
  };
  const stopMotion = () => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    motion.current = null;
    lastAt.current = 0;
    setNavTarget(null);
  };
  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(tick);
  };
  // 落到最近的整数张：多指接管、系统取消或减少动态效果时的收尾。
  const settleToRound = () => {
    const cur = latest.current.view;
    if (!cur) return;
    const n = cur.list.length;
    const pos = posRef.current;
    const target = clampGalleryPosition(Math.round(clampGalleryPosition(pos, 0, n - 1)), 0, n - 1);
    if (reduced.current || pos === target) {stopMotion(); apply(target); return;}
    stopMotion();
    motion.current = pos < 0 || pos > n - 1
      ? {kind: 'rubber', target}
      : {kind: 'rail', state: {position: pos, velocity: 0, phase: 'settle', target}};
    lastAt.current = performance.now();
    schedule();
  };
  const tick = (at: number) => {
    frame.current = 0;
    const cur = latest.current.view;
    const m = motion.current;
    if (!cur || !m) return;
    const seconds = lastAt.current ? Math.min(64, Math.max(0, at - lastAt.current)) / 1000 : 0;
    lastAt.current = at;
    if (m.kind === 'rubber') {
      const pos = m.target + (posRef.current - m.target) * Math.exp(-SETTLE_RATE * seconds);
      if (Math.abs(pos - m.target) < 0.0005) {apply(m.target); motion.current = null; setNavTarget(null); return;}
      apply(pos);
    } else {
      const next = advanceGalleryMotion(m.state, seconds, 0, cur.list.length - 1, true);
      motion.current = {kind: 'rail', state: next};
      apply(next.position);
      if (next.phase === 'idle') {motion.current = null; lastAt.current = 0; setNavTarget(null); return;}
    }
    schedule();
  };
  const step = (by: number) => {
    const cur = latest.current.view;
    if (!cur || cur.list.length < 2) return;
    const n = cur.list.length;
    const pending = motion.current?.kind === 'rail' ? motion.current.state.target : null;
    const continuing = pending !== null && Math.sign(pending - posRef.current) === by;
    const velocity = continuing && motion.current?.kind === 'rail' ? motion.current.state.velocity : 0;
    const base = continuing ? pending : Math.round(posRef.current);
    const target = clampGalleryPosition(base + by, 0, n - 1);
    stopMotion();
    if (reduced.current || target === posRef.current) {apply(target); return;}
    motion.current = {kind: 'rail', state: {position: posRef.current, velocity, phase: 'settle', target}};
    setNavTarget(target);
    lastAt.current = performance.now();
    schedule();
  };
  const close = () => {
    stopMotion();
    gesture.current = null;
    setView(null);
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      const ph = t.closest?.('.photo-thumb img,.photo-strip a') as HTMLElement | null;
      if (ph && !latest.current.view) {
        if (ph.tagName === 'A') e.preventDefault();
        const img = (ph.tagName === 'A' ? ph.querySelector('img') : ph) as HTMLImageElement;
        const box = ph.closest('.photo-thumbs,.batch-photos,.photo-strip,.import-photo-line');
        const els = box ? Array.from(box.querySelectorAll('img')) : [img];
        const list = els.map(el => el.currentSrc || el.src);
        const index = Math.max(0, els.indexOf(img));
        posRef.current = index;
        setView({list: list.length ? list : [img.currentSrc || img.src], pos: index});
        return;
      }
      if (t.id === 'lightbox') close();
    };
    // 捕获阶段先消费按键，避免底下的抽屉 / 展示页一起响应。
    const onKey = (e: KeyboardEvent) => {
      if (!latest.current.view) return;
      if (e.key === 'Escape') {e.preventDefault(); e.stopPropagation(); close();}
      else if (e.key === 'ArrowLeft') {e.preventDefault(); e.stopPropagation(); step(-1);}
      else if (e.key === 'ArrowRight') {e.preventDefault(); e.stopPropagation(); step(1);}
    };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
    };
  }, []);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onChange = () => {reduced.current = mq.matches;};
    mq.addEventListener('change', onChange);
    return () => {
      mq.removeEventListener('change', onChange);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const cur = latest.current.view;
    if (!cur || cur.list.length < 2 || e.pointerType === 'mouse') return;
    if (!e.isPrimary) {gesture.current = null; settleToRound(); return;} // 多指接管：结束拖动并落位
    stopMotion(); // 从手势 or 动画的当前位置直接接管
    trailingClick.current = false;
    gesture.current = {id: e.pointerId, x: e.clientX, y: e.clientY, start: posRef.current,
      moved: false, axis: '', samples: [{position: posRef.current, at: e.timeStamp}]};
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId || !latest.current.view) return;
    const dx = e.clientX - g.x;
    const dy = e.clientY - g.y;
    if (!g.moved && Math.hypot(dx, dy) < 3) return;
    if (!g.moved) {
      g.moved = true;
      g.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
      try {e.currentTarget.setPointerCapture(e.pointerId);} catch { /* 合成指针可能已被取消 */ }
    }
    if (e.cancelable) e.preventDefault();
    if (g.axis !== 'x') return; // 竖向手势不动轨道
    const n = latest.current.view.list.length;
    const raw = g.start - dx / window.innerWidth;
    const pos = raw < 0 ? raw * RUBBER : raw > n - 1 ? (n - 1) + (raw - (n - 1)) * RUBBER : raw;
    g.samples.push({position: pos, at: e.timeStamp});
    g.samples = g.samples.filter(sample => e.timeStamp - sample.at <= 120);
    apply(pos);
  };
  const finishGesture = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean, includeFinal: boolean) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    if (g.moved && includeFinal) onPointerMove(e); // 末点也计入释放速度
    gesture.current = null;
    if (!g.moved) return; // 普通点按，交给 click
    trailingClick.current = true;
    const cur = latest.current.view;
    if (!cur) return;
    const n = cur.list.length;
    const pos = posRef.current;
    if (cancelled || g.axis !== 'x' || reduced.current) {settleToRound(); return;}
    if (pos < 0 || pos > n - 1) {
      motion.current = {kind: 'rubber', target: pos < 0 ? 0 : n - 1};
    } else {
      const state = releaseGalleryMotion(pos, galleryReleaseVelocity(g.samples), 0, n - 1, true);
      if (state.phase === 'idle') return; // 已停在整数张上
      motion.current = {kind: 'rail', state};
    }
    lastAt.current = performance.now();
    schedule();
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => finishGesture(e, false, true);
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => finishGesture(e, true, false);
  const onLostCapture = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || !gesture.current?.moved) return;
    gesture.current = null;
    trailingClick.current = true;
    settleToRound();
  };
  // 拖动收尾后浏览器补发的 click 会因指针捕获落在根元素上，这里拦掉。
  const onClickCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.detail === 0) {trailingClick.current = false; return;} // 键盘合成的 click
    if (!trailingClick.current) return;
    trailingClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  };

  if (!view) return null;
  const n = view.list.length;
  const idx = clampGalleryPosition(Math.round(view.pos), 0, n - 1);
  const btnIdx = navTarget ?? idx;
  const base = Math.floor(view.pos);
  const slides = [];
  for (let k = Math.max(0, base - 1); k <= Math.min(n - 1, base + 1); k++) {
    slides.push(
      <div key={view.list[k]} className="lb-slide" style={{transform: `translateX(${(k - view.pos) * 100}%)`}}>
        <img src={view.list[k]} alt={`实物照片 ${k + 1}`} draggable={false}/>
      </div>,
    );
  }
  return (
    <div id="lightbox" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
         onPointerCancel={onPointerCancel} onLostPointerCapture={onLostCapture} onClickCapture={onClickCapture}>
      <div className="lb-track">{slides}</div>
      {n > 1 && <>
        {btnIdx > 0 && <button type="button" className="lb-nav lb-prev" aria-label="上一张照片" onClick={() => step(-1)}>{ChevLeftIco}</button>}
        {btnIdx < n - 1 && <button type="button" className="lb-nav lb-next" aria-label="下一张照片" onClick={() => step(1)}>{ChevRightIco}</button>}
        <span className="lb-count" aria-live="polite">{idx + 1} / {n}</span>
      </>}
    </div>
  );
}
