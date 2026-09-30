// 数字 / 日期 / 金额格式化，全部纯函数。
import type {AlbumRecord} from '../types';

export const today = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const fmt = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—'
    : Number(v).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2});

export const fmtJPY = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—'
    : Number(v).toLocaleString('zh-CN', {maximumFractionDigits: 0});

export const yuan = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—' : `¥${fmt(v)}`;

// 日元成本近似值（精确到 0.1），列表中显示在日元价格右侧
export const rmb = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '' : `≈ ¥${Number(Number(v).toFixed(1))}`;

export const jpyCost = (r: AlbumRecord): number | null =>
  r.currency === 'JPY' && r.rate && r.price !== '' ? Number(r.price) * Number(r.rate) / 100 : null;

export const sum = <T,>(xs: T[], key: keyof T & string): number =>
  xs.reduce((n, x) => n + Number((x as Record<string, unknown>)[key] || 0), 0);

export const daysSince = (d?: string): number =>
  d ? Math.max(0, Math.round((new Date(today()).getTime() - new Date(d).getTime()) / 86400000)) : 0;

export const fmtMonth = (m: string): string =>
  m ? `${Number(m.slice(0, 4))}年${Number(m.slice(5, 7))}月` : '日期未知';

// 运单运费显示：按填写币种——日元显示「X 円（≈¥Y）」，人民币只显示「¥Y」
export const shipFeeText = (currency: string | undefined, original: string | undefined, cny: string | number): string =>
  currency === 'JPY' && original ? `${fmtJPY(original)} 円（≈${yuan(cny)}）` : yuan(cny);
