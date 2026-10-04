// 列表中的副本摘要：业务金额与操作由调用方提供，详情/艺人导航互不混用。
import type {ReactNode} from 'react';
import type {AlbumRecord} from '../types';
import {labelTags} from '../types';
import {ArtistButton} from './ArtistButton';
import {Cover} from './Cover';

export function AlbumSummary({r, onDetail, onArtist, money, actions, coverOverlay, metadata}: {
  r: AlbumRecord;
  onDetail: () => void;
  onArtist?: (artist: string) => void;
  money?: ReactNode;
  actions?: ReactNode;
  coverOverlay?: ReactNode;
  metadata?: ReactNode;
}) {
  const version = labelTags(r).join(' · ');
  return <div className="album-row">
    <div className={`album-summary${actions ? ' has-actions' : ''}`} data-id={r.id}>
      <div className="album-cover">
        <button type="button" className="album-cover-button" aria-label={`查看 ${r.title} 的专辑详情`} onClick={onDetail}>
          <Cover r={r}/>
        </button>
        {coverOverlay}
      </div>
      <div className="album-info">
        <button type="button" className="album-title" title={r.title} onClick={onDetail}><span>{r.title}</span></button>
        {version || metadata ? <div className="album-meta">
          {version ? <div className="album-version" title={version}>{version}</div> : null}
          {metadata}
        </div> : null}
      </div>
      <div className="album-artist">
        {onArtist ? <ArtistButton artist={r.artist} onOpen={onArtist}/> : <span>{r.artist}</span>}
      </div>
      {money || actions ? <div className="album-aside">
        {money ? <div className="album-money">{money}</div> : null}
        {actions ? <div className="album-actions">{actions}</div> : null}
      </div> : null}
    </div>
  </div>;
}
