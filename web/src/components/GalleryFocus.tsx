import {useMemo, useRef, useState} from 'react';
import type {KeyboardEvent, PointerEvent} from 'react';
import {useApp} from '../state/AppContext';
import {isCollectedRecord} from '../core/gallery';
import type {AlbumRecord} from '../types';
import {labelTags} from '../types';
import {ArtistButton} from './ArtistButton';
import {GalleryArtwork, GalleryPhoto} from './GalleryMedia';

export interface GalleryFocusProps {
  ids: string[];
  initialId: string;
  onPick(id: string): void;
  onArtist(artist: string, id: string): void;
  onDetail(id: string): void;
}

/** 由现有 Drawer 承载：关闭/返回/焦点圈沿用共用规则，照片沿用 Lightbox。 */
export function GalleryFocus({ids, initialId, onPick, onArtist, onDetail}: GalleryFocusProps) {
  const app = useApp();
  const [selectedId, setSelectedId] = useState(initialId);
  const focusRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{id: number; x: number; y: number} | null>(null);
  const byId = useMemo(() => new Map(app.state.records.map(r => [r.id, r])), [app.state.records]);
  const records = useMemo(() => ids.map(id => byId.get(id))
    .filter((r): r is AlbumRecord => !!r && isCollectedRecord(r)), [byId, ids]);
  const found = records.findIndex(r => r?.id === selectedId);
  const index = found < 0 ? 0 : found;
  const record = records[index];
  if (!record) return <div className="gallery-focus"><p className="empty">这张副本已不在当前收藏中。</p></div>;
  const tags = labelTags(record);

  const step = (by: number) => {
    const next = records[Math.max(0, Math.min(records.length - 1, index + by))];
    if (!next || next.id === record.id) return;
    setSelectedId(next.id); onPick(next.id);
    // 从长感想/照片区换张时，新副本仍从封面开始展示。
    const body = focusRef.current?.closest<HTMLElement>('.drawer-body');
    if (body) body.scrollTop = 0;
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (document.getElementById('lightbox')) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if ((event.target as HTMLElement).closest('.photo-strip,.artist-entry,input,textarea,select,[contenteditable=true]')) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault(); step(event.key === 'ArrowRight' ? 1 : -1);
    }
  };
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // 左缘交给共用 Drawer；多指手势一旦出现，本次不再换张。
    if (!event.isPrimary || event.button !== 0 || event.clientX < 28 || pointer.current) {
      pointer.current = null;
      return;
    }
    pointer.current = {id: event.pointerId, x: event.clientX, y: event.clientY};
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointer.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = Math.abs(event.clientX - start.x), dy = Math.abs(event.clientY - start.y);
    if (dy > 10 && dy > dx) pointer.current = null;
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointer.current;
    if (!start || start.id !== event.pointerId) return;
    pointer.current = null;
    const dx = start.x - event.clientX, dy = start.y - event.clientY;
    if (event.isPrimary && Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx > 0 ? 1 : -1);
  };

  return <div className="gallery-focus" ref={focusRef} onKeyDown={onKey}
    onPointerDownCapture={event => {if (!event.isPrimary) pointer.current = null;}}>
    <div className="gallery-focus-content">
      <div className="gallery-focus-main">
        <div className="gallery-focus-cover" onDragStart={event => event.preventDefault()}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
          onPointerCancel={() => {pointer.current = null;}}
          onPointerLeave={event => {if (event.pointerType === 'mouse') pointer.current = null;}}>
          <GalleryArtwork record={record}/>
        </div>
        <div className="gallery-focus-copy">
          {record.status === 'transit' ? <span className="gallery-focus-status">在途副本</span> : null}
          <h2>{record.title}</h2>
          <ArtistButton artist={record.artist} onOpen={name => onArtist(name, record.id)}/>
          {tags.length ? <p className="gallery-focus-tags">{tags.join(' · ')}</p> : null}
          <button type="button" className="quiet gallery-detail-link" onClick={() => onDetail(record.id)}>查看资料 →</button>
        </div>
      </div>
      {record.noteAlbum ? <section className="gallery-album-note">
        <h3>专辑感想</h3><p>{record.noteAlbum}</p>
      </section> : null}
      {record.photoCount > 0 ? <section className="gallery-focus-photos">
        <h3>实物照片 <span>{record.photoCount} 张</span></h3>
        <div className="photo-strip">
          {Array.from({length: record.photoCount}, (_, i) => <GalleryPhoto key={`${record.id}-${i}`} recordId={record.id} index={i}/>)}
        </div>
      </section> : <p className="gallery-no-photos">这张副本还没有实物照片。</p>}
    </div>
    <nav className="gallery-focus-navigation" aria-label="逐张展示">
      <button type="button" className="quiet" disabled={index === 0} onClick={() => step(-1)}>← 上一张</button>
      <span aria-live="polite" className="gallery-position">{index + 1} / {records.length} 张</span>
      <button type="button" className="quiet" disabled={index === records.length - 1} onClick={() => step(1)}>下一张 →</button>
    </nav>
  </div>;
}
