// 实物照片灯箱：监听全局点击（表单缩略图 / 详情照片墙 / 识别导入 / 展示页）打开。
// 同一容器内的照片排在滑动轨道上连续翻看：触屏跟手拖动，松手沿用展示板块的
// 惯性物理（core/gallery-motion 的临界阻尼对齐，灯箱用更紧的归位速率落回整数张），
// 邻张随轨道提前挂载，不再有换图解码空窗；桌面另有左右按钮与方向键，连按会延展目标。
// 点照片本体以外的任何位置（背景、轨道、计数）或按 Esc 关闭（Esc 只关灯箱这一层）；
// 开合从被点缩略图的位置与尺寸放大/收回（WAAPI 过渡），减少动态效果时直接切换。
import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent} from 'react';
import {ChevLeftIco, ChevRightIco} from '../icons';
import {advanceGalleryMotion, clampGalleryPosition, galleryReleaseVelocity, releaseGalleryMotion} from '../../core/gallery-motion';
import type {GalleryMotionState} from '../../core/gallery-motion';

type View = {list: string[]; pos: number};
// rail = 展示板块的滑行/对齐状态；rubber = 两端外拖的回弹（rail 入口会钳制位置，回弹须在钳制外走）
type Motion = {kind: 'rail'; state: GalleryMotionState} | {kind: 'rubber'; target: number};
type Zoom = null | 'in' | 'out';
// 容器内每张照片对应的缩略图与其圆角（开合动画启动时再量位置，避免采集时机差异）
type Origin = {radius: number; thumbs: Array<HTMLImageElement | null>};

const RUBBER = 0.3;        // 两端再往外拖的阻尼比例
const LB_SETTLE = 36;      // 灯箱归位比展示板块（24/s）更紧：落回整数张更快更果断
const RUBBER_SETTLE = 26;  // 两端回弹同调收紧
const ZOOM_MS = 260;       // 开合缩放时长
const ZOOM_EASE = 'cubic-bezier(.2,.7,.3,1)';

export function Lightbox() {
  const [view, setView] = useState<View | null>(null);
  // 翻页进行中按钮跟目标位置走（同 useGalleryMotion 的 navigationTarget）：
  // round(pos) 会先一步抵达边界把按钮拆掉，快速连按就没法延展目标了。
  const [navTarget, setNavTarget] = useState<number | null>(null);
  const [zoom, setZoom] = useState<Zoom>(null);
  const latest = useRef({view});
  latest.current = {view};
  const zoomRef = useRef<Zoom>(null);
  zoomRef.current = zoom;
  const origin = useRef<Origin | null>(null);
  const introDone = useRef(false); // 本次打开的放大动画已启动/放弃，迟到的 load 不得再触发
  const zoomAnim = useRef<Animation | null>(null);
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
      const pos = m.target + (posRef.current - m.target) * Math.exp(-RUBBER_SETTLE * seconds);
      if (Math.abs(pos - m.target) < 0.0005) {apply(m.target); motion.current = null; setNavTarget(null); return;}
      apply(pos);
    } else {
      const next = advanceGalleryMotion(m.state, seconds, 0, cur.list.length - 1, true, LB_SETTLE);
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
  // 当前落位照片对应的幻灯片 img（按地址匹配，翻页中途关闭时取最近的一张）。
  const currentImg = () => {
    const cur = latest.current.view;
    const root = document.getElementById('lightbox');
    if (!cur || !root) return null;
    const index = clampGalleryPosition(Math.round(clampGalleryPosition(posRef.current, 0, cur.list.length - 1)), 0, cur.list.length - 1);
    const src = cur.list[index];
    return Array.from(root.querySelectorAll<HTMLImageElement>('.lb-slide img')).find(el => el.src === src) ?? null;
  };
  const teardown = () => {
    // 收起动画以 fill 定格末帧，随卸载结束即可，不再 cancel 以免闪回全尺寸。
    zoomAnim.current = null;
    setZoom(null);
    setView(null);
    origin.current = null;
  };
  const close = () => {
    const cur = latest.current.view;
    if (!cur || zoomRef.current === 'out') return;
    stopMotion();
    gesture.current = null;
    const data = origin.current;
    const img = currentImg();
    const index = clampGalleryPosition(Math.round(clampGalleryPosition(posRef.current, 0, cur.list.length - 1)), 0, cur.list.length - 1);
    const thumb = data?.thumbs[index] ?? null;
    const box = thumb && thumb.isConnected ? thumb.getBoundingClientRect() : null;
    if (reduced.current || !data || !img || !box || !box.width || !box.height) {
      teardown(); // 缩略图已不在或减少动态效果：维持原有的直接关闭
      return;
    }
    // 收起：从当前视觉位置（含放大动画中途的插值）缩回这张照片自己的缩略图。
    // 变换始终以未变换的落位矩形为基准：先取当前插值、定格进行中的动画，再量落位。
    const fromTransform = window.getComputedStyle(img).transform;
    const fromRadius = window.getComputedStyle(img).borderRadius;
    zoomAnim.current?.cancel();
    zoomAnim.current = null;
    const rect = img.getBoundingClientRect();
    if (!rect.width || !rect.height) {teardown(); return;}
    const sx = box.width / rect.width;
    const sy = box.height / rect.height;
    const anim = img.animate(
      [{transform: fromTransform, borderRadius: fromRadius},
       {transform: `translate(${box.left + box.width / 2 - rect.left - rect.width / 2}px, `
          + `${box.top + box.height / 2 - rect.top - rect.height / 2}px) scale(${sx}, ${sy})`,
        borderRadius: `${Math.max(0, data.radius / sx)}px`}],
      {duration: ZOOM_MS, easing: ZOOM_EASE, fill: 'forwards'});
    zoomAnim.current = anim;
    anim.finished.then(() => {
      if (zoomAnim.current === anim) teardown();
    }).catch(() => {});
    setZoom('out');
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
        // 记录容器内逐张对应的缩略图与圆角；位置到动画启动时再量（见下）。
        const radius = parseFloat(window.getComputedStyle(img).borderTopLeftRadius);
        origin.current = {radius: Number.isFinite(radius) ? radius : 0,
          thumbs: els.map(el => el instanceof HTMLImageElement ? el : null)};
        introDone.current = false;
        setView({list: list.length ? list : [img.currentSrc || img.src], pos: index});
        return;
      }
      if (!latest.current.view) return;
      // 照片本体与导航键各守其义；轨道、背景与计数都算「照片以外」，点按即收起。
      if (t.closest('.lb-slide img,.lb-nav')) return;
      if (t.closest('#lightbox')) close();
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

  // 打开动画：把当前照片从被点缩略图的位置与尺寸放大到落位。灯箱 img 与缩略图
  // 同址（缓存命中），但元素是本帧新插入的，CSS transition 对新元素不生效，改用
  // WAAPI；缩略图位置在启动瞬间现量（点击后面板/滚动可能变化）。图片未解码、
  // 缩略图缺失或已开始手势时放弃动画，直接显示。
  useLayoutEffect(() => {
    if (!view || zoomRef.current) return;
    const data = origin.current;
    const img = currentImg();
    if (!data || !img) return;
    const index = clampGalleryPosition(Math.round(clampGalleryPosition(posRef.current, 0, view.list.length - 1)), 0, view.list.length - 1);
    const thumb = data.thumbs[index] ?? null;
    const start = () => {
      if (introDone.current || zoomRef.current || gesture.current) return;
      if (!img.complete || !img.naturalWidth || !img.isConnected) return;
      if (!thumb || !thumb.isConnected) return;
      const rect = img.getBoundingClientRect();
      const box = thumb.getBoundingClientRect();
      if (!rect.width || !rect.height || !box.width || !box.height) return;
      introDone.current = true;
      const sx = box.width / rect.width;
      const sy = box.height / rect.height;
      const anim = img.animate(
        [{transform: `translate(${box.left + box.width / 2 - rect.left - rect.width / 2}px, `
            + `${box.top + box.height / 2 - rect.top - rect.height / 2}px) scale(${sx}, ${sy})`,
          borderRadius: `${Math.max(0, data.radius / sx)}px`},
         {transform: 'none', borderRadius: window.getComputedStyle(img).borderRadius}],
        {duration: ZOOM_MS, easing: ZOOM_EASE});
      zoomAnim.current = anim;
      anim.finished.then(() => {
        if (zoomAnim.current === anim) {zoomAnim.current = null; setZoom(null);}
      }).catch(() => {});
      setZoom('in');
    };
    if (img.complete) start();
    else img.addEventListener('load', start, {once: true});
    return () => img.removeEventListener('load', start);
  }, [view !== null]);
  // 过渡兜底：后台标签可能推迟动画结束事件，到点强制收尾（'out' 同时卸载灯箱）。
  useLayoutEffect(() => {
    if (!zoom) return;
    const timer = window.setTimeout(() => {
      if (zoom === 'out') teardown();
      else setZoom(null);
    }, ZOOM_MS + 250);
    return () => window.clearTimeout(timer);
  }, [zoom]);

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
    if (zoomRef.current === 'out') return; // 收起动画期间不再接管
    if (zoomRef.current === 'in') { // 放大动画让位给手势：定格到落位再接管
      zoomAnim.current?.cancel();
      zoomAnim.current = null;
      setZoom(null);
      zoomRef.current = null;
    }
    introDone.current = true; // 手势一旦开始，本次打开不再补播放大动画
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
    <div id="lightbox" className={zoom === 'in' ? 'lb-intro' : zoom === 'out' ? 'lb-closing' : undefined}
         onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
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
