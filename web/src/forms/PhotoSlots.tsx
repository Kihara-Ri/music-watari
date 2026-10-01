// 照片槽管理：占位（处理中）→ 并发池压缩回填；上限 30 张；删除任意位置。
import {useRef, useState} from 'react';
import {isPending, MAX_PHOTOS, PhotoQueue, PhotoSlot} from '../core/photos';

export function usePhotoSlots(initial: PhotoSlot[], notify: (m: string, kind?: 'warn' | 'err') => void) {
  const [slots, setSlots] = useState<PhotoSlot[]>(initial);
  const queue = useRef(new PhotoQueue());

  const addFiles = (files: File[]) => {
    const room = Math.max(MAX_PHOTOS - slots.length, 0);
    if (files.length > room) notify(`一次最多再加 ${room} 张`, 'warn');
    const picks = files.slice(0, room);
    if (!picks.length) return;
    const tokens = picks.map(() => crypto.randomUUID());
    setSlots(prev => [...prev, ...tokens.map(token => ({pending: true, token} as PhotoSlot))]);
    picks.forEach((file, k) => {
      const token = tokens[k];
      queue.current.add(
        file,
        data => setSlots(prev => prev.map(p => p.token === token && 'pending' in p ? {data, token} : p)),
        msg => setSlots(prev => prev.map(p => p.token === token && 'pending' in p ? {error: msg, token} : p)),
      );
    });
  };

  const remove = (i: number) => setSlots(prev => prev.filter((_, k) => k !== i));

  return {slots, addFiles, remove, hasPending: slots.some(isPending)};
}

export function PhotoThumbs({slots, recordId, small = false, onRemove}: {
  slots: PhotoSlot[]; recordId: string | null; small?: boolean; onRemove: (i: number) => void;
}) {
  if (!slots.length) return null;
  return (
    <div className={small ? 'batch-photos' : 'photo-thumbs'}>
      {slots.map((p, i) => {
        const close = <button type="button" onClick={() => onRemove(i)} aria-label="移除这张照片">×</button>;
        const cls = `photo-thumb${small ? ' small' : ''}${'pending' in p ? ' pending' : ''}${'error' in p ? ' failed' : ''}`;
        if ('pending' in p) {
          return <div key={i} className={cls}><span className="ph-wait"/><span className="ph-tag">处理中</span>{close}</div>;
        }
        if ('error' in p) {
          return <div key={i} className={cls}><span className="ph-tag err" title={p.error}>处理失败</span>{close}</div>;
        }
        const src = 'existing' in p ? `/api/photo/${recordId}/${p.existing}` : p.data;
        return <div key={i} className={cls}><img src={src} alt={`实物照片 ${i + 1}`} loading="lazy"/>{close}</div>;
      })}
    </div>
  );
}
