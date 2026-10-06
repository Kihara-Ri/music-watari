import type {AlbumRecord} from '../types';
import {GalleryArtwork} from './GalleryMedia';

/** The rail moves the button; this inner body handles only contact lift. */
export function GalleryCase({record, spatial = false}: {record: AlbumRecord; spatial?: boolean}) {
  const sleeve = ['纸盒', '纸套', 'digipak'].includes(record.version.trim().toLowerCase());
  return <span className={`gallery-case gallery-case--${spatial ? 'spatial' : 'flat'}${sleeve ? ' gallery-case--sleeve' : ''}`}>
    <span className="gallery-case-shadow" aria-hidden="true"/>
    <span className="gallery-case-body">
      {spatial ? <>
        <span className="gallery-case-face gallery-case-face--rear" aria-hidden="true"/>
        <span className="gallery-case-face gallery-case-face--left" aria-hidden="true"/>
        <span className="gallery-case-face gallery-case-face--right" aria-hidden="true"/>
        <span className="gallery-case-face gallery-case-face--top" aria-hidden="true"/>
        <span className="gallery-case-face gallery-case-face--bottom" aria-hidden="true"/>
        <span className="gallery-case-face gallery-case-face--front"><GalleryArtwork record={record}/></span>
      </> : <GalleryArtwork record={record}/>}
    </span>
  </span>;
}
