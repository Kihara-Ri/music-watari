import {useEffect, useMemo, useRef, useState} from 'react';
import type {KeyboardEvent} from 'react';
import {galleryIndex, GALLERY_ROAMING_DEFAULTS} from '../core/gallery';
import {labelTags} from '../types';
import type {AlbumRecord} from '../types';
import type {GalleryStageProps} from './GalleryStage';
import {GalleryCase} from './GalleryCase';
import {ArtistButton} from './ArtistButton';
import {useGalleryRoaming, roamGalleryScroller} from './useGalleryRoaming';
import type {GalleryScrollPosition} from './useGalleryRoaming';

/** 封面墙保持原生纵向浏览；瀑布流漫游单独控制各列的滚动位置。 */
export function GalleryWall({records, mode, currentId, density, showTitles, roaming = false, roamingSpeed = GALLERY_ROAMING_DEFAULTS[mode],
                             onPick, onFocus, onArtist}: GalleryStageProps) {
  const root = useRef<HTMLDivElement>(null);
  const scrollStates = useRef(new WeakMap<HTMLElement, GalleryScrollPosition>());
  const [columnCount, setColumnCount] = useState(2);
  const [roamViewport, setRoamViewport] = useState(false);
  const index = galleryIndex(records, currentId);
  const columns = useMemo(() => {
    const result: AlbumRecord[][] = Array.from({length: columnCount}, () => []);
    records.forEach((r, i) => result[i % columnCount].push(r)); return result;
  }, [records, columnCount]);
  useEffect(() => {
    if (mode !== 'waterfall') return;
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
  useEffect(() => {if (roaming) setRoamViewport(true);}, [roaming]);
  useGalleryRoaming(root, roaming && roamViewport, seconds => {
    const area = root.current; if (!area) return;
    const scrollers = mode === 'waterfall' ? [...area.querySelectorAll<HTMLElement>('.gallery-waterfall-column')] : [area];
    scrollers.forEach((element, i) => {
      let state = scrollStates.current.get(element);
      if (!state) {state = {position: element.scrollTop, painted: element.scrollTop, direction: 1}; scrollStates.current.set(element, state);}
      const cover = element.querySelector<HTMLElement>('.gallery-cover-button');
      const pitch = (cover?.getBoundingClientRect().height || 160) + 24;
      const stagger = mode === 'waterfall' ? [1, 1.18, .92, 1.08, .96, 1.12][i % 6] : 1;
      roamGalleryScroller(element, state, seconds, pitch * stagger / roamingSpeed);
    });
  });
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-current="true"]')?.scrollIntoView({block: 'nearest', behavior: 'instant'});
  }, [mode]);
  const key = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey
        || document.getElementById('panel') || document.getElementById('lightbox')
        || (event.target as HTMLElement).closest('.artist-entry')) return;
    if (!['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
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
            aria-label={`查看封面：${r.title} · ${r.artist}`} onClick={() => onFocus(r.id)} title={r.title}>
      <GalleryCase record={r}/>
    </button>
    {showTitles || mode === 'waterfall' ? <div className="gallery-tile-caption">
      <button type="button" className="gallery-title" onClick={() => onFocus(r.id)}>{r.title}</button>
      <ArtistButton artist={r.artist} onOpen={name => onArtist(name, r.id)}/>
      {labelTags(r).length ? <span className="gallery-tile-tags">{labelTags(r).join(' · ')}</span> : null}
    </div> : null}
  </div>;
  return <div ref={root} className={`gallery-stage gallery-stage--${mode} gallery-density--${density}${roamViewport ? ' has-roam-viewport' : ''}`}
              tabIndex={0} role="region" aria-label="收藏展示，方向键选择封面" onKeyDown={key}
              onDragStart={event => event.preventDefault()}>
    {mode === 'tiles' ? <div className="gallery-wall">{records.map(tile)}</div>
      : <div className="gallery-waterfall">{columns.map((items, i) => <div key={i} className="gallery-waterfall-column">{items.map(tile)}</div>)}</div>}
  </div>;
}
