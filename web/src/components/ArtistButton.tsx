// 艺人入口与专辑详情入口独立；页面/表单负责导航。
export function ArtistButton({artist, onOpen}: {artist: string; onOpen: (artist: string) => void}) {
  return <div className="artist-entry">
    <span className="artist-entry-label">艺人</span>
    <button type="button" className="artist-button" aria-label={`查看 ${artist} 的资料与作品`}
            onClick={() => onOpen(artist)}>
      <span>{artist}</span><span className="artist-entry-arrow" aria-hidden="true">›</span>
    </button>
  </div>;
}
