// 封面 / 缩略图 / 价格格：卡片、详情、销售行共用。
import type {AlbumRecord} from '../types';
import {fmt, fmtJPY, jpyCost, rmb} from '../core/format';

export function Cover({r}: {r: AlbumRecord}) {
  if (r.cover) return <img className="cover" src={r.cover} alt={`${r.title}封面`} loading="lazy"/>;
  const h = [...r.artist].reduce((a, c) => a + c.charCodeAt(0), 0) % 4;
  return (
    <div className={`cover cover-fallback hue-${h}`} role="img" aria-label={`${r.title}，暂无封面`}>
      <span>{r.title.slice(0, 1)}</span>
    </div>
  );
}

export function Thumb({r}: {r: AlbumRecord}) {
  return <div className="thumb"><Cover r={r}/></div>;
}

export function PriceCell({r}: {r: AlbumRecord}) {
  if (r.price === '') return <span className="p">—</span>;
  const c = jpyCost(r);
  return (
    <>
      <span className="p">
        {r.currency === 'JPY' ? fmtJPY(r.price) : fmt(r.price)}
        <small>{r.currency === 'JPY' ? '円' : '元'}</small>
      </span>
      {c ? <span className="rmb">{rmb(c)}</span> : null}
    </>
  );
}
