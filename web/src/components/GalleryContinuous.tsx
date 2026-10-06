import {useEffect, useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {KeyboardEvent, MouseEvent, PointerEvent} from 'react';
import type {GalleryStageProps} from './GalleryStage';
import {galleryIndex} from '../core/gallery';
import {labelTags} from '../types';
import {ArtistButton} from './ArtistButton';
import {GalleryCase} from './GalleryCase';
import {GalleryFilmNavigator, galleryFilmProgressLabel} from './GalleryFilmNavigator';
import {useGalleryMotion} from './useGalleryMotion';
import {galleryIsometricSlots, wrapGalleryPosition} from '../core/gallery-motion';

const ISO_POSE_EXTENT = 16;

function stageKey(event: KeyboardEvent<HTMLDivElement>, step: (by: number) => void) {
  if (event.defaultPrevented || event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
      document.getElementById('panel') || document.getElementById('lightbox')) return;
  if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    event.preventDefault(); step(event.key === 'ArrowRight' ? 1 : -1);
  }
}

function ContinuousArrow({next = false}: {next?: boolean}) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={next ? 'M5 12h14m-6-6 6 6-6 6' : 'M19 12H5m6-6-6 6 6 6'}/>
  </svg>;
}

function StageControls({index, count, start, end, step, showPosition = true}: {
  index: number; count: number; start: boolean; end: boolean; step(by: number): void; showPosition?: boolean;
}) {
  return <div className="gallery-stage-controls" role="group" aria-label="连续浏览收藏">
    <button type="button" className="gallery-stage-arrow" disabled={start} aria-label="向前浏览" title="向前浏览"
      onClick={() => step(-1)}><ContinuousArrow/></button>
    {showPosition ? <span className="gallery-stage-position" aria-hidden="true">{index + 1} / {count}</span> : null}
    <button type="button" className="gallery-stage-arrow" disabled={end} aria-label="向后浏览" title="向后浏览"
      onClick={() => step(1)}><ContinuousArrow next/></button>
  </div>;
}

/** 手机使用原生横向滚动；桌面拖动只写 scrollLeft，不引入吸附。 */
export function GalleryFilm(props: GalleryStageProps) {
  const {records, currentId, density, onFocus} = props;
  const railRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<HTMLInputElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const scopeKey = useMemo(() => JSON.stringify(records.map(r => r.id)), [records]);
  const selected = galleryIndex(records, currentId);
  const [settledPosition, setSettledPosition] = useState(selected);
  const [limits, setLimits] = useState((selected === 0 ? 1 : 0) | (selected === records.length - 1 ? 2 : 0));
  const limitsRef = useRef(limits);
  const metric = useRef(1);
  const lastEcho = useRef(currentId);
  const restoredScope = useRef<string | null>(null);
  const timer = useRef(0);
  const frame = useRef(0);
  const trailingClick = useRef(false);
  const seeking = useRef(false);
  const drag = useRef<{id: number; x: number; y: number; scroll: number; moved: boolean} | null>(null);

  const readPosition = () => {
    const rail = railRef.current;
    if (!rail) return 0;
    const position = Math.max(0, Math.min(latest.current.records.length - 1, rail.scrollLeft / metric.current));
    if (rangeRef.current) {
      rangeRef.current.value = String(position);
      rangeRef.current.setAttribute('aria-valuetext', galleryFilmProgressLabel(position, latest.current.records.length));
    }
    const edges = (position < .001 ? 1 : 0) | (position >= latest.current.records.length - 1 - .001 ? 2 : 0);
    if (edges !== limitsRef.current) {limitsRef.current = edges; setLimits(edges);}
    return position;
  };
  const commit = () => {
    if (seeking.current || drag.current?.moved) return;
    const rail = railRef.current;
    const position = Math.max(0, Math.min(latest.current.records.length - 1, (rail?.scrollLeft || 0) / metric.current));
    const next = Math.round(position);
    const record = latest.current.records[next];
    if (!record) return;
    setSettledPosition(position);
    lastEcho.current = record.id;
    if (record.id !== latest.current.currentId) latest.current.onPick(record.id);
  };
  const onScroll = () => {
    if (!frame.current) frame.current = requestAnimationFrame(() => {frame.current = 0; readPosition();});
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(commit, 140);
  };

  useLayoutEffect(() => {
    const rail = railRef.current;
    if (!rail) return;
    const measure = () => {
      const items = rail.querySelectorAll<HTMLElement>('.gallery-film-item');
      const previousPosition = rail.scrollLeft / metric.current;
      const first = items[0], second = items[1];
      metric.current = Math.max(1, second && first ? second.getBoundingClientRect().left - first.getBoundingClientRect().left
        : (first ? parseFloat(getComputedStyle(first).width) : 1) + (parseFloat(getComputedStyle(rail).columnGap) || 0));
      rail.scrollLeft = Math.max(0, Math.min(records.length - 1, previousPosition)) * metric.current;
      readPosition();
    };
    measure();
    if (restoredScope.current !== scopeKey) {
      rail.scrollLeft = selected * metric.current;
      setSettledPosition(selected);
      lastEcho.current = currentId;
      restoredScope.current = scopeKey;
    }
    readPosition();
    const observer = new ResizeObserver(measure);
    observer.observe(rail);
    return () => observer.disconnect();
  }, [scopeKey, density]);

  useEffect(() => {
    if (lastEcho.current === currentId) return;
    lastEcho.current = currentId;
    const rail = railRef.current;
    if (rail) rail.scrollLeft = selected * metric.current;
    setSettledPosition(selected);
    readPosition();
  }, [currentId, selected]);
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    if (frame.current) cancelAnimationFrame(frame.current);
  }, []);

  const release = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    if (active.moved && event.type === 'pointerup') event.currentTarget.scrollLeft = active.scroll - (event.clientX - active.x);
    drag.current = null;
    event.currentTarget.removeAttribute('data-dragging');
    if (active.moved) trailingClick.current = true;
    try {if (event.currentTarget.hasPointerCapture(active.id)) event.currentTarget.releasePointerCapture(active.id);} catch { /* 已由浏览器取消。 */ }
    readPosition(); commit();
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    trailingClick.current = false;
    if (!event.isPrimary) {drag.current = null; event.currentTarget.removeAttribute('data-dragging'); return;}
    if (event.pointerType !== 'mouse' || event.button !== 0) return;
    window.clearTimeout(timer.current);
    event.currentTarget.scrollTo({left: event.currentTarget.scrollLeft, behavior: 'instant'});
    drag.current = {id: event.pointerId, x: event.clientX, y: event.clientY, scroll: event.currentTarget.scrollLeft, moved: false};
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = drag.current;
    if (!active || active.id !== event.pointerId) return;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    if (!active.moved) {
      if (Math.hypot(dx, dy) < 5) return;
      if (Math.abs(dy) > Math.abs(dx)) {trailingClick.current = true; drag.current = null; return;}
      active.moved = true;
      event.currentTarget.setAttribute('data-dragging', 'true');
      try {event.currentTarget.setPointerCapture(event.pointerId);} catch { /* 合成或已取消的指针。 */ }
    }
    event.preventDefault();
    event.currentTarget.scrollLeft = active.scroll - dx;
    readPosition();
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.detail !== 0 && (drag.current?.moved || trailingClick.current)) {
      trailingClick.current = false;
      event.preventDefault(); event.stopPropagation();
    }
  };
  const step = (by: number) => {
    const rail = railRef.current;
    if (!rail) return;
    const target = Math.max(0, Math.min(records.length - 1, Math.round(readPosition()) + by));
    rail.scrollTo({left: target * metric.current,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth'});
  };
  const startSeek = () => {
    seeking.current = true;
    window.clearTimeout(timer.current);
    const rail = railRef.current;
    if (rail) rail.scrollTo({left: rail.scrollLeft, behavior: 'instant'});
  };
  const seek = (position: number) => {
    const rail = railRef.current;
    if (!rail) return;
    rail.scrollLeft = Math.max(0, Math.min(records.length - 1, position)) * metric.current;
    readPosition();
  };
  const endSeek = () => {seeking.current = false; readPosition(); commit();};

  return <div className={`gallery-stage gallery-stage--film gallery-density--${density}`} tabIndex={0}
    role="region" aria-label="胶片连续浏览，左右方向键浏览" onKeyDown={event => stageKey(event, step)}>
    <div className="gallery-film-shell">
      <div className="gallery-film-rail" ref={railRef} onScroll={onScroll} onDragStart={event => event.preventDefault()}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={release} onPointerCancel={release}
        onLostPointerCapture={release} onClickCapture={onClickCapture}>
        {records.map((record, index) => <div key={record.id} className="gallery-film-item" data-motion-index={index}>
          <button type="button" className="gallery-cover-button gallery-continuous-cover gallery-case-button"
            aria-label={`查看封面：${record.title} · ${record.artist}`} title={record.title}
            onClick={() => {lastEcho.current = record.id; onFocus(record.id);}}>
            <GalleryCase record={record}/>
          </button>
        </div>)}
      </div>
      <GalleryFilmNavigator rangeRef={rangeRef} count={records.length} initialPosition={settledPosition}
        start={!!(limits & 1)} end={!!(limits & 2)} onStep={step}
        onSeek={seek} onSeekStart={startSeek} onSeekEnd={endSeek}/>
    </div>
    <span className="gallery-visually-hidden" aria-live="polite" aria-atomic="true">{galleryFilmProgressLabel(settledPosition, records.length)}</span>
  </div>;
}

function tableAngle(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0;
  return (hash >>> 0) % 9;
}

/** 全部实物在一个自然延伸的桌面中，没有选中卡或整组翻页。 */
export function GalleryTable({records, currentId, density, showTitles, onFocus, onArtist}: GalleryStageProps) {
  const root = useRef<HTMLDivElement>(null);
  const scopeKey = useMemo(() => JSON.stringify(records.map(r => r.id)), [records]);
  useEffect(() => {
    if (!currentId) return;
    const buttons = root.current?.querySelectorAll<HTMLElement>('[data-record-id]');
    [...(buttons || [])].find(button => button.dataset.recordId === currentId)
      ?.scrollIntoView({block: 'nearest', inline: 'nearest', behavior: 'instant'});
  }, [scopeKey]);
  return <div ref={root} className={`gallery-stage gallery-stage--table gallery-density--${density}`}
    role="region" aria-label="桌面连续铺开，向下滚动查看全部收藏">
    <div className="gallery-table-grid" onDragStart={event => event.preventDefault()}>
      {records.map(record => {
        const tags = labelTags(record);
        return <div key={record.id} className={`gallery-table-item gallery-table-angle--${tableAngle(record.id)}`}>
        <button type="button" className="gallery-cover-button gallery-continuous-cover gallery-case-button" data-record-id={record.id}
          aria-label={`查看封面：${record.title} · ${record.artist}`} title={record.title} onClick={() => onFocus(record.id)}>
          <GalleryCase record={record} spatial/>
        </button>
        {showTitles ? <div className="gallery-tile-caption">
          <button type="button" className="gallery-title" title={record.title} onClick={() => onFocus(record.id)}>{record.title}</button>
          <ArtistButton artist={record.artist} onOpen={artist => onArtist(artist, record.id)}/>
          {tags.length ? <span className="gallery-tile-tags">{tags.join(' · ')}</span> : null}
        </div> : null}
      </div>;
      })}
    </div>
  </div>;
}

/** 三条错列组成连续等距墙；只保留附近行，小数位置不吸附。 */
export function GalleryIsometric({records, currentId, density, roaming = false, onPick, onFocus}: GalleryStageProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const gestureArea = useRef<HTMLDivElement>(null);
  const index = galleryIndex(records, currentId);
  const [center, setCenter] = useState(Math.floor(index / 3));
  const centerRef = useRef(Math.floor(index / 3));
  const [nearest, setNearest] = useState(index);
  const nearestRef = useRef(index);
  const [radius, setRadius] = useState(4);
  const axisStep = useRef(140);
  const geometry = useRef({width: 320, height: 326, size: 100});
  const poses = useRef(new Map<number, {row: number; lane: number; animation: Animation; node: HTMLElement; button: HTMLButtonElement | null}>());
  const scopeKey = useMemo(() => JSON.stringify(records.map(r => r.id)), [records]);

  const paint = (position: number) => {
    poses.current.forEach(pose => {
      const rowOffset = pose.row - position / 3;
      pose.animation.currentTime = Math.max(0, Math.min(ISO_POSE_EXTENT * 2, rowOffset + ISO_POSE_EXTENT)) * 1000;
      const {width, height, size} = geometry.current;
      const stagger = pose.lane === 1 ? .5 : 0;
      const cross = (pose.lane - 1) * size * .82;
      const x = (rowOffset + stagger) * axisStep.current + cross;
      const y = (rowOffset + stagger) * axisStep.current - cross;
      const visible = Math.abs(x) < width * .5 + size * .75 && Math.abs(y) < height * .5 + size * .7;
      if (pose.button) pose.button.tabIndex = visible ? 0 : -1;
      if (visible) pose.node.removeAttribute('aria-hidden');
      else {
        if (pose.button === document.activeElement) viewport.current?.closest<HTMLElement>('.gallery-stage')?.focus({preventScroll: true});
        pose.node.setAttribute('aria-hidden', 'true');
      }
    });
  };
  const motion = useGalleryMotion({
    position: index, min: 0, max: Math.max(0, records.length - 1), snap: false, scopeKey,
    loopCount: records.length, autoRun: roaming,
    // 每个方向约 8px/s，沿斜轨道的实际速度约 11px/s，与封面尺寸无关。
    autoVelocity: () => 24 / axisStep.current,
    project: (start, point, startPosition) => startPosition - ((point.x - start.x) + (point.y - start.y)) * 3 / (axisStep.current * 2),
    onFrame: position => {
      paint(position);
      const nextCenter = Math.floor(position / 3);
      if (nextCenter !== centerRef.current) {centerRef.current = nextCenter; setCenter(nextCenter);}
      const nextNearest = wrapGalleryPosition(Math.round(position), records.length);
      if (nextNearest !== nearestRef.current) {nearestRef.current = nextNearest; setNearest(nextNearest);}
    },
    onCommit: position => {const record = records[wrapGalleryPosition(Math.round(position), records.length)]; if (record && record.id !== currentId) onPick(record.id);},
    onDragStart: () => viewport.current?.setAttribute('data-dragging', 'true'),
    onDragEnd: () => viewport.current?.removeAttribute('data-dragging'),
  });
  const slots = useMemo(() => galleryIsometricSlots(center * 3, records.length, radius), [center, records.length, radius]);

  useLayoutEffect(() => {
    const area = viewport.current;
    if (!area) return;
    const measure = () => {
      const item = area.querySelector<HTMLElement>('.gallery-isometric-item');
      const size = item ? parseFloat(getComputedStyle(item).width) : 150;
      axisStep.current = Math.max(1, size * .94);
      const width = gestureArea.current?.clientWidth || area.clientWidth;
      geometry.current = {width, height: area.clientHeight, size};
      setRadius(Math.max(2, Math.min(6, Math.ceil(Math.min(width, area.clientHeight) / (axisStep.current * 2) + 2.7))));
      paint(motion.positionRef.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [scopeKey, density]);
  // 新进入缓冲区的封面在浏览器绘制前就取得正确的暂停动画位置。
  useLayoutEffect(() => {paint(motion.positionRef.current);}, [slots, records, density]);

  const step = (by: number) => motion.moveTo(motion.positionRef.current + by);
  // 拖后点击由 rail capture 消费；键盘生成的 click 仍正常打开。
  const open = (id: string) => {motion.stop(false); onFocus(id);};
  return <div className={`gallery-stage gallery-stage--isometric gallery-density--${density}`} tabIndex={0}
    role="region" aria-label="等距封面墙，沿左上和右下拖动连续浏览" onKeyDown={event => stageKey(event, step)}>
    <div className="gallery-isometric-shell">
      <div ref={viewport} className="gallery-isometric-viewport" {...motion.handlers} onDragStart={event => event.preventDefault()}
        onPointerDown={event => {
          motion.handlers.onPointerDown(event);
          if (event.isPrimary && !gestureArea.current?.contains(event.target as Node)) motion.stop();
        }}>
        <div ref={gestureArea} className="gallery-isometric-gesture">
        {slots.map(({slot, row, lane, recordIndex}) => {
          const record = records[recordIndex];
          return <div key={slot} className={`gallery-isometric-item gallery-isometric-lane--${lane}`} data-motion-index={slot}
          ref={node => {
            if (!node) {poses.current.delete(slot); return;}
            const animation = node.getAnimations().find(a => (a as CSSAnimation).animationName === 'gallery-isometric-position');
            if (animation) {
              animation.pause();
              poses.current.set(slot, {row, lane, animation, node, button: node.querySelector('button')});
              animation.currentTime = (row - motion.positionRef.current / 3 + ISO_POSE_EXTENT) * 1000;
            }
          }}>
          <button type="button" className="gallery-cover-button gallery-continuous-cover gallery-case-button"
            aria-label={`查看封面：${record.title} · ${record.artist}`} title={record.title} onClick={() => open(record.id)}>
            <GalleryCase record={record} spatial/>
          </button>
        </div>;
        })}
        </div>
      </div>
      <StageControls index={nearest} count={records.length} start={false} end={false} step={step} showPosition={false}/>
    </div>
    <span className="gallery-visually-hidden" aria-live={roaming ? 'off' : 'polite'} aria-atomic="true">
      {roaming ? '正在缓慢循环漫游' : '可沿斜向轨道循环浏览'}，当前范围共 {records.length} 张
    </span>
  </div>;
}
