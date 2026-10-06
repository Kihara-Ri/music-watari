import type {KeyboardEvent, RefObject} from 'react';

export function galleryFilmProgressLabel(position: number, count: number): string {
  if (count <= 1) return '全部收藏已显示，无需移动';
  const progress = Math.round(Math.max(0, Math.min(1, position / (count - 1))) * 100);
  return `连续浏览进度 ${progress}%`;
}

function FilmArrow({next = false}: {next?: boolean}) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <path d={next ? 'M5 12h14m-6-6 6 6-6 6' : 'M19 12H5m6-6-6 6 6 6'}/>
  </svg>;
}

interface Props {
  rangeRef: RefObject<HTMLInputElement | null>;
  count: number;
  initialPosition: number;
  start: boolean;
  end: boolean;
  onStep(by: number): void;
  onSeek(position: number): void;
  onSeekStart(): void;
  onSeekEnd(): void;
}

/** 滑杆与原生胶片轨道共用连续位置，视觉和触控面属于同一条操作带。 */
export function GalleryFilmNavigator({rangeRef, count, initialPosition, start, end, onStep, onSeek, onSeekStart, onSeekEnd}: Props) {
  const maximum = Math.max(0, count - 1);
  const key = (event: KeyboardEvent<HTMLInputElement>) => {
    let value = Number(event.currentTarget.value);
    switch (event.key) {
      case 'ArrowRight': case 'ArrowUp': value += 1; break;
      case 'ArrowLeft': case 'ArrowDown': value -= 1; break;
      case 'Home': value = 0; break;
      case 'End': value = maximum; break;
      case 'PageUp': value += maximum / 10; break;
      case 'PageDown': value -= maximum / 10; break;
      default: return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    onSeekStart();
    onSeek(Math.max(0, Math.min(maximum, value)));
    onSeekEnd();
  };

  return <div className="gallery-film-navigator" role="group" aria-label="胶片连续浏览">
    <button type="button" className="gallery-film-nav-arrow" disabled={count <= 1 || start}
      aria-label="向前浏览" title="向前浏览" onClick={() => onStep(-1)}><FilmArrow/></button>
    <input ref={rangeRef} type="range" className="gallery-film-seek" min={0} max={Math.max(1, maximum)} step="any"
      defaultValue={initialPosition} disabled={count <= 1} aria-label="胶片连续浏览位置"
      aria-valuetext={galleryFilmProgressLabel(initialPosition, count)} onKeyDown={key}
      onInput={event => onSeek(Number(event.currentTarget.value))}
      onPointerDown={event => {if (event.isPrimary) onSeekStart();}}
      onPointerUp={onSeekEnd} onPointerCancel={onSeekEnd} onBlur={onSeekEnd}/>
    <button type="button" className="gallery-film-nav-arrow" disabled={count <= 1 || end}
      aria-label="向后浏览" title="向后浏览" onClick={() => onStep(1)}><FilmArrow next/></button>
  </div>;
}
