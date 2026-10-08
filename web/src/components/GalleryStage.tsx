import type {AlbumRecord} from '../types';
import type {GalleryDensity, GalleryMode} from '../core/gallery';
import {GalleryWall} from './GalleryWall';
import {GalleryOrbit} from './GalleryOrbit';
import {GalleryFilm, GalleryTable, GalleryIsometric} from './GalleryContinuous';

export interface GalleryStageProps {
  records: AlbumRecord[];
  mode: GalleryMode;
  currentId: string | null;
  density: GalleryDensity;
  showTitles: boolean;
  roaming?: boolean;
  roamingSpeed?: number;
  onPick(id: string): void;
  onFocus(id: string): void;
  onArtist(artist: string, id: string): void;
}

/** 每种布局拥有自己的连续运动模型；共用数据范围和封面入口。 */
export function GalleryStage(props: GalleryStageProps) {
  const contacts = useRef(new Map<number, HTMLElement>());
  const release = (id?: number) => {
    if (id !== undefined) {
      contacts.current.get(id)?.classList.remove('is-gallery-contact'); contacts.current.delete(id);
    } else {
      contacts.current.forEach(button => button.classList.remove('is-gallery-contact')); contacts.current.clear();
    }
  };
  useEffect(() => {
    // 轨道接管指针后 pointerup 可能不再到达按钮，统一在 window 捕获阶段释放触碰状态。
    const up = (event: PointerEvent) => release(event.pointerId);
    const clear = () => release();
    const hidden = () => {if (document.hidden) clear();};
    window.addEventListener('pointerup', up, true); window.addEventListener('pointercancel', up, true);
    window.addEventListener('blur', clear); document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pointerup', up, true); window.removeEventListener('pointercancel', up, true);
      window.removeEventListener('blur', clear); document.removeEventListener('visibilitychange', hidden); clear();
    };
  }, []);
  useEffect(() => release(), [props.mode, props.records]);
  const touch = (event: ReactPointerEvent<HTMLDivElement>) => {
    release(event.pointerId);
    if (!event.isPrimary || event.button !== 0) {release(); return;}
    const button = event.target instanceof Element ? event.target.closest<HTMLElement>('.gallery-cover-button') : null;
    if (button) {button.classList.add('is-gallery-contact'); contacts.current.set(event.pointerId, button);}
  };
  if (!props.records.length) return null;
  const scene = props.mode === 'film' ? <GalleryFilm {...props}/>
    : props.mode === 'table' ? <GalleryTable {...props}/>
      : props.mode === 'isometric' ? <GalleryIsometric {...props}/>
        : props.mode === 'tiles' || props.mode === 'waterfall' ? <GalleryWall {...props}/>
          : <GalleryOrbit {...props}/>;
  return <div className="gallery-stage-layout" data-mode={props.mode} onPointerDownCapture={touch}>{scene}</div>;
}
import {useEffect, useRef} from 'react';
import type {PointerEvent as ReactPointerEvent} from 'react';
