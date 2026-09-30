// 实物照片灯箱：监听全局点击（表单缩略图 / 详情照片墙），点背景或 Esc 关闭。
import {useEffect, useState} from 'react';

export function Lightbox() {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const ph = (e.target as HTMLElement).closest?.('.photo-thumb img,.photo-strip a') as HTMLElement | null;
      if (ph && !src) {
        if (ph.tagName === 'A') e.preventDefault();
        const el = (ph.tagName === 'A' ? ph.querySelector('img') : ph) as HTMLImageElement;
        setSrc(el.currentSrc || el.src);
        return;
      }
      if ((e.target as HTMLElement).id === 'lightbox') setSrc(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSrc(null); };
    document.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [src]);

  if (!src) return null;
  return <div id="lightbox" onClick={e => { if (e.target === e.currentTarget) setSrc(null); }}><img src={src} alt="实物照片"/></div>;
}
