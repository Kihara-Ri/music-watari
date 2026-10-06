import {useState} from 'react';
import type {AlbumRecord} from '../types';
import {Cover} from './Cover';

/** 仍复用共同封面组件；失效的图片保留与缺封面不同的可见说明。 */
export function GalleryArtwork({record}: {record: AlbumRecord}) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  const failed = !!record.cover && failedSource === record.cover;
  return <span className="gallery-artwork" onErrorCapture={() => setFailedSource(record.cover)}>
    <Cover r={failed ? {...record, cover: ''} : record}/>
    {!record.cover || failed ? <span className="gallery-art-message">
      {failed ? '封面载入失败' : '暂无封面'}
    </span> : null}
  </span>;
}

export function GalleryPhoto({recordId, index}: {recordId: string; index: number}) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const source = `/api/photo/${recordId}/${index}`;
  if (failed) return <div className="gallery-photo-error">
    <span>照片 {index + 1} 载入失败</span>
    <button type="button" className="quiet" onClick={() => {setAttempt(a => a + 1); setFailed(false);}}>重试</button>
  </div>;
  // photo-strip 是现有 Lightbox 的入口，链接中的 img 地址由其共用逻辑读取。
  return <a href={source} target="_blank" rel="noopener noreferrer" aria-label={`放大实物照片 ${index + 1}`}>
    <img key={attempt} src={attempt ? `${source}?retry=${attempt}` : source}
         alt={`实物照片 ${index + 1}`} loading="lazy" onError={() => setFailed(true)}/>
  </a>;
}
