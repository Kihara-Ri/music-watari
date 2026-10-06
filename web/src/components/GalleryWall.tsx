import {useEffect, useMemo, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {galleryIndex} from '../core/gallery';
import {labelTags} from '../types';
import type {AlbumRecord} from '../types';
import type {GalleryStageProps} from './GalleryStage';
import {GalleryCase} from './GalleryCase';
import {ArtistButton} from './ArtistButton';

/** 封面墙保持原生纵向浏览；瀑布流漫游单独控制各列的滚动位置。 */
export function GalleryWall({records, mode, currentId, density, showTitles, roaming = false,
                             onPauseRoaming, onPick, onFocus, onArtist}: GalleryStageProps) {
  const root = useRef<HTMLDivElement>(null);
  const pauseRef = useRef(onPauseRoaming); pauseRef.current = onPauseRoaming;
  const [columnCount, setColumnCount] = useState(2);
  const [roamViewport, setRoamViewport] = useState(false);
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const index = galleryIndex(records, currentId);
  const columns = useMemo(() => {
    const result: AlbumRecord[][] = Array.from({length: columnCount}, () => []);
    records.forEach((r, i) => result[i % columnCount].push(r)); return result;
  }, [records, columnCount]);
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => {setReduced(media.matches); if (media.matches) pauseRef.current?.();};
    media.addEventListener('change', change); return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    if (mode !== 'waterfall') {setRoamViewport(false); return;}
    const el = root.current; if (!el) return;
    const resize = () => {
      const narrow = el.clientWidth < 420;
      const minimum = density === 'small' ? narrow ? 90 : 110
        : density === 'large' ? narrow ? 174 : 218 : narrow ? 126 : 146;
      const gap = narrow ? 10 : 12;
      setColumnCount(Math.max(1, Math.min(6, Math.floor((el.clientWidth + gap) / (minimum + gap)))));
    };
    resize(); const observer = new ResizeObserver(resize); observer.observe(el);
    return () => observer.disconnect();
  }, [mode, density]);
  useEffect(() => {if (mode === 'waterfall' && roaming && !reduced) setRoamViewport(true);}, [mode, roaming, reduced]);
  useEffect(() => {
    if (mode !== 'waterfall' || !roaming || reduced || !roamViewport) return;
    let frame = 0, previous = 0;
    const directions = new Map<HTMLElement, number>(), positions = new Map<HTMLElement, number>();
    const speeds = [8, 11, 9.5, 13, 10, 12];
    const columns = Array.from(root.current?.querySelectorAll<HTMLElement>('.gallery-waterfall-column') ?? []);
    const advance = (at: number) => {
      const elapsed = previous ? Math.min(at - previous, 64) / 1000 : 0; previous = at;
      if (!document.hidden && !document.getElementById('panel') && !document.getElementById('lightbox')) columns.forEach((el, i) => {
        const end = el.scrollHeight - el.clientHeight; if (end <= 1) return;
        let direction = directions.get(el) ?? 1;
        const next = (positions.get(el) ?? el.scrollTop) + speeds[i % speeds.length] * elapsed * direction;
        if (next >= end) direction = -1; else if (next <= 0) direction = 1;
        const value = Math.max(0, Math.min(end, next));
        el.scrollTop = value; positions.set(el, value); directions.set(el, direction);
      });
      frame = requestAnimationFrame(advance);
    };
    frame = requestAnimationFrame(advance); return () => cancelAnimationFrame(frame);
  }, [mode, roaming, reduced, roamViewport, columnCount, records]);
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({block: 'nearest', behavior: 'instant'});
  }, [mode]);
  const pause = () => {if (roaming) pauseRef.current?.();};
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || document.getElementById('panel') || document.getElementById('lightbox')
        || (event.target as HTMLElement).closest('.artist-entry')) return;
    if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault(); pause();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? records.length - 1
      : Math.max(0, Math.min(records.length - 1, index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1)));
    onPick(records[next].id);
    requestAnimationFrame(() => {
      const cover = root.current?.querySelector<HTMLElement>('[data-current="true"] .gallery-cover-button');
      cover?.focus({preventScroll: true}); cover?.scrollIntoView({block: 'nearest', behavior: 'instant'});
    });
  };
  const tile = (r: AlbumRecord) => <div key={r.id} className="gallery-item" data-current={r.id === records[index]?.id}>
    <button type="button" className="gallery-cover-button gallery-case-button" tabIndex={r.id === records[index]?.id ? 0 : -1}
            aria-label={`查看封面：${r.title} · ${r.artist}`} onClick={() => {pause(); onFocus(r.id);}} title={r.title}>
      <GalleryCase record={r}/>
    </button>
    {showTitles || mode === 'waterfall' ? <div className="gallery-tile-caption">
      <button type="button" className="gallery-title" onClick={() => {pause(); onFocus(r.id);}}>{r.title}</button>
      <ArtistButton artist={r.artist} onOpen={name => {pause(); onArtist(name, r.id);}}/>
      {labelTags(r).length ? <span className="gallery-tile-tags">{labelTags(r).join(' · ')}</span> : null}
    </div> : null}
  </div>;
  return <div ref={root} className={`gallery-stage gallery-stage--${mode} gallery-density--${density}${roamViewport && mode === 'waterfall' ? ' has-roam-viewport' : ''}`}
              tabIndex={0} role="region" aria-label="收藏展示，方向键选择封面" onKeyDown={key}
              onPointerDownCapture={pause} onKeyDownCapture={pause} onWheelCapture={pause} onDragStart={event => event.preventDefault()}>
    {mode === 'tiles' ? <div className="gallery-wall">{records.map(tile)}</div>
      : <div className="gallery-waterfall">{columns.map((items, i) => <div key={i} className="gallery-waterfall-column">{items.map(tile)}</div>)}</div>}
  </div>;
}
