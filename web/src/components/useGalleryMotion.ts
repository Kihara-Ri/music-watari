import {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import type {MouseEvent, PointerEvent} from 'react';
import {advanceGalleryMotion, clampGalleryPosition, galleryReleaseVelocity, releaseGalleryMotion, wrapGalleryPosition} from '../core/gallery-motion';
import type {GalleryMotionState, GalleryPoint} from '../core/gallery-motion';

export interface GalleryMotionOptions {
  position: number;
  min: number;
  max: number;
  onFrame(position: number): void;
  onCommit(position: number): void;
  project(start: GalleryPoint, current: GalleryPoint, startPosition: number, anchor: HTMLElement | null): number;
  snap: boolean;
  enabled?: boolean;
  scopeKey?: string;
  onDragStart?(): void;
  onDragEnd?(): void;
  /** Circular rails keep an unbounded local position; only the saved anchor wraps. */
  loopCount?: number;
  autoRun?: boolean;
  autoVelocity?(): number;
}

interface Gesture {
  id: number;
  start: GalleryPoint;
  position: number;
  anchor: HTMLElement | null;
  element: HTMLDivElement;
  moved: boolean;
  samples: Array<{position: number; at: number}>;
}

/** One continuous rail position. React and saved preferences only see committed anchors. */
export function useGalleryMotion(options: GalleryMotionOptions) {
  const latest = useRef(options);
  latest.current = options;
  const positionRef = useRef(clampGalleryPosition(options.position, options.min, options.max));
  const draggingRef = useRef(false);
  const gesture = useRef<Gesture | null>(null);
  const motion = useRef<GalleryMotionState | null>(null);
  const stepTarget = useRef<number | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<number | null>(null);
  const frame = useRef(0);
  const previousAt = useRef(0);
  const trailingClick = useRef(false);
  const lastCommitted = useRef(options.position);
  const lastExternal = useRef(options.position);
  const lastScope = useRef(options.scopeKey);
  const reduced = useRef(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const tickRef = useRef<(at: number) => void>(() => {});
  const resumeAt = useRef(0);
  const wasAutoRunning = useRef(false);
  const pressedPointers = useRef(new Set<number>());
  const blurred = useRef(false);
  const bounds = () => latest.current.loopCount
    ? {min: -Infinity, max: Infinity} : {min: latest.current.min, max: latest.current.max};

  const commit = useCallback(() => {
    lastCommitted.current = latest.current.loopCount
      ? wrapGalleryPosition(Math.round(positionRef.current), latest.current.loopCount) : positionRef.current;
    latest.current.onCommit(positionRef.current);
  }, []);
  const releaseCapture = useCallback((active: Gesture) => {
    try {
      if (active.element.hasPointerCapture(active.id)) active.element.releasePointerCapture(active.id);
    } catch { /* The browser can have canceled this pointer already. */ }
  }, []);
  const clearStepTarget = useCallback(() => {
    if (stepTarget.current === null) return;
    stepTarget.current = null;
    setNavigationTarget(null);
  }, []);
  const stop = useCallback((save = true) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
    motion.current = null;
    clearStepTarget();
    previousAt.current = 0;
    const active = gesture.current;
    gesture.current = null;
    draggingRef.current = false;
    if (active) {
      releaseCapture(active);
      if (active.moved) latest.current.onDragEnd?.();
    }
    latest.current.onFrame(positionRef.current);
    if (save) commit();
  }, [clearStepTarget, commit, releaseCapture]);
  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(at => tickRef.current(at));
  }, []);

  tickRef.current = at => {
    frame.current = 0;
    if (document.hidden || document.getElementById('panel') || document.getElementById('lightbox')) {
      stop(); return;
    }
    const state = motion.current;
    const seconds = previousAt.current ? Math.min(64, Math.max(0, at - previousAt.current)) / 1000 : 0;
    previousAt.current = at;
    if (state) {
      const {min, max} = bounds();
      motion.current = advanceGalleryMotion(state, seconds, min, max, latest.current.snap);
      positionRef.current = motion.current.position;
    } else if (latest.current.autoRun && !reduced.current && !gesture.current && !pressedPointers.current.size && at >= resumeAt.current) {
      const velocity = latest.current.autoVelocity?.() || 0;
      if (Number.isFinite(velocity)) positionRef.current += velocity * seconds;
    }
    latest.current.onFrame(positionRef.current);
    if (motion.current?.phase !== 'idle' && motion.current) schedule();
    else if (motion.current) {motion.current = null; clearStepTarget(); commit();}
    if (latest.current.autoRun && !reduced.current && !gesture.current && !pressedPointers.current.size) schedule();
    else if (!motion.current) previousAt.current = 0;
  };

  const moveTo = useCallback((position: number, animate = true) => {
    stop(false);
    resumeAt.current = performance.now() + 2800;
    trailingClick.current = false;
    const {min, max} = bounds();
    const target = clampGalleryPosition(position, min, max);
    if (!animate || reduced.current || target === positionRef.current) {
      positionRef.current = target;
      latest.current.onFrame(target);
      commit();
      if (latest.current.autoRun && !reduced.current) schedule();
      return;
    }
    motion.current = {position: positionRef.current, velocity: 0, phase: 'settle', target};
    previousAt.current = performance.now();
    schedule();
  }, [commit, schedule, stop]);

  /** Repeated steps extend the destination immediately; reversing starts from
   * the visible position. No intermediate destinations are queued. */
  const step = useCallback((by: number) => {
    const pending = stepTarget.current;
    const continuing = pending !== null && Math.sign(pending - positionRef.current) === Math.sign(by);
    const base = continuing ? pending : Math.round(positionRef.current);
    const velocity = continuing && Math.sign(motion.current?.velocity || 0) === Math.sign(by)
      ? motion.current?.velocity || 0 : 0;
    const {min, max} = bounds();
    const target = clampGalleryPosition(base + by, min, max);
    moveTo(target);
    if (motion.current?.phase === 'settle') {
      motion.current.velocity = velocity;
      stepTarget.current = target;
      setNavigationTarget(target);
    }
    return target;
  }, [moveTo]);

  // An onCommit rounded anchor echo must not erase a free, fractional rail position.
  useLayoutEffect(() => {
    const scopeChanged = lastScope.current !== options.scopeKey;
    const externalChanged = lastExternal.current !== options.position;
    lastScope.current = options.scopeKey;
    lastExternal.current = options.position;
    if (scopeChanged || options.enabled === false || (externalChanged &&
        options.position !== Math.round(lastCommitted.current) && options.position !== lastCommitted.current)) {
      stop(false);
      trailingClick.current = false;
      positionRef.current = clampGalleryPosition(options.position, options.min, options.max);
      lastCommitted.current = options.position;
      latest.current.onFrame(positionRef.current);
    }
  }, [options.position, options.min, options.max, options.enabled, options.scopeKey, stop]);

  useEffect(() => {
    if (options.autoRun && !reduced.current) {
      previousAt.current = 0;
      schedule();
    } else if (wasAutoRunning.current) stop();
    wasAutoRunning.current = !!options.autoRun;
  }, [options.autoRun, schedule, stop]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => {
      reduced.current = preference.matches;
      if (preference.matches) {
        const target = latest.current.snap ? Math.round(positionRef.current) : positionRef.current;
        moveTo(target, false);
      }
    };
    const resume = () => {
      if (latest.current.autoRun && !reduced.current && !document.hidden && !blurred.current &&
          !document.getElementById('panel') && !document.getElementById('lightbox')) {
        previousAt.current = 0; schedule();
      }
    };
    const hide = () => {if (document.hidden) stop(); else resume();};
    const blur = () => {blurred.current = true; pressedPointers.current.clear(); stop();};
    const focus = () => {blurred.current = false; resume();};
    const release = (event: globalThis.PointerEvent) => {
      if (!pressedPointers.current.delete(event.pointerId)) return;
      resumeAt.current = performance.now() + 2800;
      if (!pressedPointers.current.size) resume();
    };
    const observer = new MutationObserver(() => {
      if ((gesture.current || motion.current || frame.current) && (document.getElementById('panel') || document.getElementById('lightbox'))) stop();
      else if (!frame.current) resume();
    });
    observer.observe(document.body, {childList: true, subtree: true});
    preference.addEventListener('change', change);
    document.addEventListener('visibilitychange', hide);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', focus);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', release, true);
    return () => {
      observer.disconnect();
      preference.removeEventListener('change', change);
      document.removeEventListener('visibilitychange', hide);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', focus);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', release, true);
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      motion.current = null;
      stepTarget.current = null;
      const active = gesture.current;
      gesture.current = null;
      if (active) releaseCapture(active);
    };
  }, [moveTo, releaseCapture, schedule, stop]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button === 0) pressedPointers.current.add(event.pointerId);
    // Every new down denotes a new intentional tap, not the old drag's synthetic click.
    trailingClick.current = false;
    if (!event.isPrimary || (gesture.current && gesture.current.id !== event.pointerId)) {stop(); return;}
    if (event.button !== 0 || latest.current.enabled === false || document.hidden ||
        document.getElementById('panel') || document.getElementById('lightbox')) return;
    if ((event.target as HTMLElement).closest('.gallery-stage-controls, a, input, textarea, select')) return;
    if (event.pointerType === 'touch' && event.clientX < 28) {stop(); return;}
    stop(false);
    resumeAt.current = performance.now() + 2800;
    gesture.current = {id: event.pointerId, start: {x: event.clientX, y: event.clientY},
      position: positionRef.current, anchor: (event.target as HTMLElement).closest<HTMLElement>('[data-motion-index]'),
      element: event.currentTarget, moved: false, samples: [{position: positionRef.current, at: event.timeStamp}]};
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!event.isPrimary) {stop(); return;}
    if (!active || active.id !== event.pointerId) return;
    const point = {x: event.clientX, y: event.clientY};
    if (!active.moved && Math.hypot(point.x - active.start.x, point.y - active.start.y) < 3) return;
    if (!active.moved) {
      active.moved = true;
      draggingRef.current = true;
      latest.current.onDragStart?.();
      // Capturing only after movement preserves a normal button tap's click target.
      try {active.element.setPointerCapture(active.id);} catch { /* Canceled / synthetic pointer. */ }
    }
    if (event.cancelable) event.preventDefault();
    const {min, max} = bounds();
    positionRef.current = clampGalleryPosition(latest.current.project(active.start, point, active.position, active.anchor), min, max);
    active.samples.push({position: positionRef.current, at: event.timeStamp});
    active.samples = active.samples.filter(sample => event.timeStamp - sample.at <= 120);
    schedule();
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    // Include the final point, including a pause before release, in release velocity.
    if (active.moved) onPointerMove(event);
    gesture.current = null;
    draggingRef.current = false;
    resumeAt.current = performance.now() + 2800;
    releaseCapture(active);
    if (!active.moved) {motion.current = null; if (latest.current.autoRun && !reduced.current) schedule(); return;}
    trailingClick.current = true;
    latest.current.onDragEnd?.();
    if (reduced.current) {
      positionRef.current = latest.current.snap ? Math.round(positionRef.current) : positionRef.current;
      latest.current.onFrame(positionRef.current);
      commit();
      return;
    }
    const {min, max} = bounds();
    motion.current = releaseGalleryMotion(positionRef.current, galleryReleaseVelocity(active.samples), min, max, latest.current.snap);
    previousAt.current = performance.now();
    if (motion.current.phase === 'idle') {
      motion.current = null; latest.current.onFrame(positionRef.current); commit();
      if (latest.current.autoRun) schedule();
    }
    else schedule();
  };
  const cancelPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (gesture.current?.id !== event.pointerId) return;
    const moved = gesture.current.moved;
    stop();
    resumeAt.current = performance.now() + 2800;
    if (latest.current.autoRun && !reduced.current) schedule();
    trailingClick.current = moved;
  };
  const lostCapture = (event: PointerEvent<HTMLDivElement>) => {
    // A touch button's implicit capture is intentionally transferred to the rail.
    // Its bubbled lostcapture event does not mean the rail lost its own capture.
    if (event.target === event.currentTarget) cancelPointer(event);
  };
  const onClickCapture = (event: MouseEvent<HTMLDivElement>) => {
    if (event.detail === 0) {if (!draggingRef.current) trailingClick.current = false; return;}
    if (draggingRef.current || trailingClick.current) {
      trailingClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    }
  };

  return {positionRef, draggingRef, navigationTarget, moveTo, step, stop,
    isClickSuppressed: () => draggingRef.current || trailingClick.current,
    handlers: {onPointerDown, onPointerMove, onPointerUp,
      onPointerCancel: cancelPointer, onLostPointerCapture: lostCapture, onClickCapture}};
}
