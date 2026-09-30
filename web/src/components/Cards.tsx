// 库存卡片与网格：同一专辑（标题+艺人相同）的副本聚成一组，
// 副本组跨列 = min(副本数, 网格列数)，subgrid 保证与相邻卡片同宽。
import {useEffect, useMemo, useRef} from 'react';
import type {ReactNode} from 'react';
import type {AlbumRecord} from '../types';
import {norm} from '../core/search';
import {CamIco} from './icons';
import {Cover, PriceCell} from './Cover';

export function AlbumCard({r, page, checked, onSelect, onDetail, actions}: {
  r: AlbumRecord; page: string; checked: boolean;
  onSelect?: (id: string, on: boolean) => void;
  onDetail: (id: string) => void;
  actions: ReactNode;
}) {
  const tags = [r.pressing ? (r.pressing === '日版' && r.obi ? `${r.pressing}·${r.obi}` : r.pressing) : '', r.version].filter(Boolean);
  return (
    <article className="card" data-id={r.id}>
      <div className="cover-wrap">
        <div className="card-badges">
          {page === 'overseas' ? <span className="badge overseas">海外</span> : null}
          {r.listed && page !== 'trash' ? <span className="badge listed">已上架</span> : null}
          {r.cover ? null : <span className="badge nocover">待抓取</span>}
        </div>
        {page !== 'trash' && onSelect ? (
          <label className="card-check">
            <input type="checkbox" checked={checked} aria-label={`选择 ${r.title}`}
                   onChange={e => onSelect(r.id, e.target.checked)}/>
          </label>
        ) : null}
        {r.photoCount ? (
          <span className="photo-flag" title={`有 ${r.photoCount} 张实物照片`}>{CamIco}{r.photoCount}</span>
        ) : null}
        <Cover r={r}/>
      </div>
      <div className="card-body">
        <button className="card-title" onClick={() => onDetail(r.id)}>{r.title}</button>
        <div className="card-artist">{r.artist}</div>
        {tags.length ? (
          <div className="card-tags">{tags.map(t => <span key={t} className="card-edt">{t}</span>)}</div>
        ) : null}
        <div className="card-price"><PriceCell r={r}/></div>
      </div>
      <div className="card-actions">{actions}</div>
    </article>
  );
}

// 网格：副本分组 + 跨列修正（窗口宽度变化会改变列数，随 resize 重算）
export function CardGrid({records, renderCard}: {
  records: AlbumRecord[]; renderCard: (r: AlbumRecord) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const runs = useMemo(() => {
    const map = new Map<string, AlbumRecord[]>();
    for (const r of records) {
      const k = norm(r.title) + '␟' + norm(r.artist);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(r);
    }
    return [...map.values()];
  }, [records]);

  useEffect(() => {
    const fix = () => {
      const g = ref.current;
      if (!g) return;
      let cols = 3;
      try { cols = getComputedStyle(g).gridTemplateColumns.split(' ').length; } catch { /* 无样式时兜底 */ }
      g.querySelectorAll<HTMLElement>('.copy-group').forEach(cg => {
        cg.style.gridColumn = `span ${Math.max(1, Math.min(cg.children.length, cols))}`;
      });
    };
    fix();
    let timer = 0;
    const onResize = () => { clearTimeout(timer); timer = window.setTimeout(fix, 180); };
    window.addEventListener('resize', onResize);
    return () => { clearTimeout(timer); window.removeEventListener('resize', onResize); };
  });

  return (
    <div className="grid" ref={ref}>
      {runs.map(run => run.length > 1 ? (
        <div className="copy-group" key={run[0].id} title="同一专辑的多张副本">
          {run.map(renderCard)}
        </div>
      ) : run.map(renderCard))}
    </div>
  );
}
