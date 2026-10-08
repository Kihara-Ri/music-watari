import {useEffect, useRef} from 'react';
import type {RefObject} from 'react';
import {advanceGalleryRoaming} from '../core/gallery-motion';

/** Native scrollers retain their position and yield to the hand without clearing intent. */
export function useGalleryRoaming(root: RefObject<HTMLElement | null>, enabled: boolean,
                                  advance: (seconds: number) => void) {
  const latest = useRef(advance); latest.current = advance;
  useEffect(() => {
    const area = root.current;
    if (!enabled || !area) return;
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const contacts = new Set<number>();
    let frame = 0, previous = 0, resumeAt = 0, blurred = false, wasBlocked = false;
    const postpone = () => {resumeAt = performance.now() + 2800; previous = 0;};
    const down = (event: PointerEvent) => {contacts.add(event.pointerId); postpone();};
    const up = (event: PointerEvent) => {if (contacts.delete(event.pointerId)) postpone();};
    const blur = () => {blurred = true; contacts.clear(); postpone();};
    const focus = () => {blurred = false; previous = 0;};
    const visibility = () => {previous = 0; if (document.hidden) contacts.clear();};
    const tick = (at: number) => {
      const blocked = document.hidden || blurred || media.matches || contacts.size > 0 ||
        !!document.querySelector('#panel, #lightbox, dialog[open]');
      if (wasBlocked && !blocked) postpone();
      wasBlocked = blocked;
      if (!blocked && at >= resumeAt) {
        const seconds = previous ? Math.min(64, Math.max(0, at - previous)) / 1000 : 0;
        latest.current(seconds);
        previous = at;
      } else previous = 0;
      frame = requestAnimationFrame(tick);
    };
    area.addEventListener('pointerdown', down, true);
    area.addEventListener('wheel', postpone, {passive: true});
    area.addEventListener('keydown', postpone);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', blur); window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      area.removeEventListener('pointerdown', down, true);
      area.removeEventListener('wheel', postpone); area.removeEventListener('keydown', postpone);
      window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', blur); window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [root, enabled]);
}

export interface GalleryScrollPosition {position: number; painted: number; direction: number}

/** Keep fractional travel even in browsers that round scrollTop to whole pixels. */
export function roamGalleryScroller(element: HTMLElement, state: GalleryScrollPosition,
                                     seconds: number, pixelsPerSecond: number, horizontal = false) {
  const actual = horizontal ? element.scrollLeft : element.scrollTop;
  if (Math.abs(actual - state.painted) > 1) state.position = actual;
  const maximum = horizontal ? element.scrollWidth - element.clientWidth : element.scrollHeight - element.clientHeight;
  const next = advanceGalleryRoaming(state.position, state.direction, seconds, pixelsPerSecond, 0, maximum);
  state.position = next.position; state.direction = next.direction;
  if (horizontal) element.scrollLeft = next.position; else element.scrollTop = next.position;
  state.painted = horizontal ? element.scrollLeft : element.scrollTop;
}
