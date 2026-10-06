import {useLayoutEffect, useMemo, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {galleryIndex} from '../core/gallery';
import {galleryFanLayer, galleryOrbitPoint, galleryOrbitPose, projectGalleryOrbit} from '../core/gallery-motion';
import type {GalleryOrbitMode} from '../core/gallery-motion';
import type {GalleryStageProps} from './GalleryStage';
import {GalleryCase} from './GalleryCase';
import {useGalleryMotion} from './useGalleryMotion';

function OrbitArrow({next = false}: {next?: boolean}) {
  return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={next ? 'M5 12h14m-6-6 6 6-6 6' : 'M19 12H5m6-6-6 6 6 6'}/>
  </svg>;
}

/** The rear shell sits behind the opaque cards. Side walls and a full front
 * board occlude their lower edges; they do not inherit the moving card pose. */
function CrateShell({front = false}: {front?: boolean}) {
  return <div className={`gallery-crate-shell gallery-crate-shell--${front ? 'front' : 'rear'}`} aria-hidden="true">
    {front ? <>
      <span className="gallery-crate-side gallery-crate-side--left"/>
      <span className="gallery-crate-side gallery-crate-side--right"/>
      <span className="gallery-crate-board"><span className="gallery-crate-handle"/></span>
    </> : <>
      <span className="gallery-crate-floor"/>
      <span className="gallery-crate-back"/>
    </>}
  </div>;
}

/** Bounded, continuously scrubbed cover rails for the four central display modes. */
export function GalleryOrbit({records, mode, currentId, onPick, onFocus}: GalleryStageProps) {
  const orbitMode = mode as GalleryOrbitMode;
  const index = galleryIndex(records, currentId);
  const [windowCenter, setWindowCenter] = useState(index);
  const [activeIndex, setActiveIndex] = useState(index);
  const centerRef = useRef(index);
  const activeRef = useRef(index);
  const keyboardFocus = useRef(false);
  const space = useRef<HTMLDivElement>(null);
  const rail = useRef<HTMLDivElement>(null);
  const crateRecords = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<number, {node: HTMLDivElement; button: HTMLButtonElement | null}>());
  const animations = useRef(new Map<number, Animation>());
  const geometry = useRef({size: 190, perspective: 1050});
  const livePosition = useRef(index);
  const scopeKey = useMemo(() => `${mode}:${records.map(record => record.id).join('|')}`, [mode, records]);

  const paint = (position: number) => {
    livePosition.current = position;
    const nextCenter = Math.floor(position);
    if (centerRef.current !== nextCenter) {centerRef.current = nextCenter; setWindowCenter(nextCenter);}
    const selected = Math.max(0, Math.min(records.length - 1, Math.round(position)));
    if (selected !== activeRef.current) {activeRef.current = selected; setActiveIndex(selected);}
    for (const [recordIndex, entry] of nodes.current) {
      const {node, button} = entry;
      let animation = animations.current.get(recordIndex);
      if (!animation) {
        animation = node.getAnimations().find(candidate => candidate.effect?.getTiming().duration === 1000);
        if (animation) animations.current.set(recordIndex, animation);
      }
      const offset = recordIndex - position;
      if (animation) animation.currentTime = (Math.max(-4, Math.min(4, offset)) + 4) * 125;
      const active = recordIndex === selected;
      const changed = node.dataset.current !== String(active);
      if (changed) node.dataset.current = String(active);
      node.classList.toggle('is-current', active);
      node.classList.toggle('is-orbit-near', !active && Math.abs(offset) < 1.6);
      if (mode === 'fan') {
        const layer = String(galleryFanLayer(offset));
        if (node.dataset.fanLayer !== layer) node.dataset.fanLayer = layer;
      } else if (node.dataset.fanLayer) delete node.dataset.fanLayer;
      node.classList.toggle('is-orbit-outgoing', mode === 'crate' && offset < 0 && offset > -2);
      node.classList.toggle('is-orbit-hidden', galleryOrbitPose(orbitMode, offset).opacity <= .001);
      if (button && changed) {
        button.tabIndex = active ? 0 : -1;
        button.setAttribute('aria-pressed', String(active));
        const record = records[recordIndex];
        if (record) button.setAttribute('aria-label', `${active ? '放大展示' : '选择'}：${record.title} · ${record.artist}`);
      }
    }
  };

  const motion = useGalleryMotion({position: index, min: 0, max: Math.max(0, records.length - 1), snap: true,
    scopeKey, enabled: records.length > 0,
    onDragStart: () => space.current?.setAttribute('data-dragging', 'true'),
    onDragEnd: () => space.current?.removeAttribute('data-dragging'),
    onFrame: paint,
    onCommit: position => {
      const selected = Math.max(0, Math.min(records.length - 1, Math.round(position)));
      if (records[selected]) onPick(records[selected].id);
      if (keyboardFocus.current) {
        keyboardFocus.current = false;
        requestAnimationFrame(() => nodes.current.get(selected)?.button?.focus({preventScroll: true}));
      }
    },
    project: (start, current, startPosition, anchor) => {
      const recordIndex = anchor ? Number(anchor.dataset.motionIndex) : Math.round(startPosition);
      const startOffset = recordIndex - startPosition;
      const origin = galleryOrbitPoint(orbitMode, startOffset, geometry.current.size, geometry.current.perspective);
      const point = {x: origin.x + current.x - start.x, y: origin.y + current.y - start.y};
      const offset = projectGalleryOrbit(orbitMode, point, geometry.current.size,
        recordIndex - livePosition.current, geometry.current.perspective);
      return recordIndex - offset;
    },
  });

  // Measurements occur on resize/mount, never in the pointer or frame loop.
  useLayoutEffect(() => {
    const element = space.current;
    if (!element) return;
    const measure = () => {
      const first = nodes.current.values().next().value;
      const perspectiveElement = mode === 'crate' ? crateRecords.current : rail.current;
      geometry.current = {size: first?.node.offsetWidth || 190,
        perspective: Number.parseFloat(getComputedStyle(perspectiveElement || element).perspective) || 1050};
      motion.stop(false);
      paint(motion.positionRef.current);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode, scopeKey]);
  useLayoutEffect(() => {paint(motion.positionRef.current);}, [windowCenter, activeIndex, mode, scopeKey]);

  if (!records.length) return null;
  const first = Math.max(0, windowCenter - 4), last = Math.min(records.length, windowCenter + 5);
  const choose = (recordIndex: number) => {
    if (motion.isClickSuppressed()) return;
    if (recordIndex === Math.round(motion.positionRef.current)) onFocus(records[recordIndex].id);
    else motion.moveTo(recordIndex);
  };
  const step = (by: number) => {
    if (mode === 'fan') motion.step(by);
    else motion.moveTo(Math.round(motion.positionRef.current) + by);
  };
  const controlIndex = mode === 'fan' ? motion.navigationTarget ?? activeIndex : activeIndex;
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey ||
        document.getElementById('panel') || document.getElementById('lightbox')) return;
    const selected = Math.round(motion.positionRef.current);
    const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
    const backward = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
    if (forward || backward || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      keyboardFocus.current = true;
      if (forward || backward) step(forward ? 1 : -1);
      else motion.moveTo(event.key === 'Home' ? 0 : records.length - 1, false);
    } else if (event.key === 'Enter' && event.target === event.currentTarget) {
      event.preventDefault(); onFocus(records[selected].id);
    }
  };

  const cards = records.slice(first, last).map((record, offset) => {
    const recordIndex = first + offset;
    const active = recordIndex === activeIndex;
    return <div key={record.id} className={`gallery-item gallery-orbit-card${active ? ' is-current' : ''}`}
      data-motion-index={recordIndex} data-current={active}
      ref={node => {
        if (node) nodes.current.set(recordIndex, {node, button: node.querySelector<HTMLButtonElement>('.gallery-cover-button')});
        else {nodes.current.delete(recordIndex); animations.current.delete(recordIndex);}
      }}>
      <button type="button" className="gallery-cover-button gallery-case-button" tabIndex={active ? 0 : -1}
        aria-pressed={active} aria-label={`${active ? '放大展示' : '选择'}：${record.title} · ${record.artist}`}
        title={record.title} onClick={() => choose(recordIndex)}><GalleryCase record={record} spatial/></button>
    </div>;
  });

  return <div className={`gallery-stage gallery-stage--${mode} gallery-orbit`} tabIndex={0} role="region"
    aria-label="专辑展示，拖动封面沿轨道移动，方向键切换专辑" onKeyDown={key}>
    <div ref={space} className="gallery-space gallery-orbit-space" {...motion.handlers}
      onPointerDown={event => {
        motion.handlers.onPointerDown(event);
        // Native pan is possible in the outer edge strips. A new edge down also
        // clears the previous drag's pending click and stops an in-flight rail.
        const controls = (event.target as HTMLElement).closest('.gallery-stage-controls');
        if (!rail.current?.contains(event.target as Node) && !(mode === 'fan' && controls)) motion.stop();
      }}
      onDragStart={event => event.preventDefault()} data-count={last - first}>
      <div ref={rail} className="gallery-orbit-rail">
      {mode === 'crate' ? <CrateShell/> : null}
      {mode === 'crate' ? <div className="gallery-crate-records" ref={crateRecords}>{cards}</div> : cards}
      {mode === 'crate' ? <CrateShell front/> : null}
      </div>
      <div className="gallery-stage-controls" role="group" aria-label="切换专辑">
        <button type="button" className="gallery-stage-arrow" disabled={controlIndex <= 0}
          aria-label="上一张副本" title="上一张" onClick={() => step(-1)}>
          <OrbitArrow/>
        </button>
        <span className="gallery-stage-position" aria-hidden="true">{activeIndex + 1} / {records.length}</span>
        <button type="button" className="gallery-stage-arrow" disabled={controlIndex >= records.length - 1}
          aria-label="下一张副本" title="下一张" onClick={() => step(1)}>
          <OrbitArrow next/>
        </button>
      </div>
    </div>
    <span className="gallery-visually-hidden" aria-live="polite" aria-atomic="true">
      第 {index + 1} 张，共 {records.length} 张；{records[index].title}，{records[index].artist}
    </span>
  </div>;
}
