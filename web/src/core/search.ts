// 搜索与模糊匹配：罗马音转写 / 艺人别名 / 缩写 / 多词 AND / Levenshtein 容错。
// 全部纯函数，供列表过滤与录入表单建议共用。

import type {AlbumRecord} from '../types';

const KANA: Record<string, string> = {
  あ: 'a', い: 'i', う: 'u', え: 'e', お: 'o',
  か: 'ka', き: 'ki', く: 'ku', け: 'ke', こ: 'ko',
  さ: 'sa', し: 'shi', す: 'su', せ: 'se', そ: 'so',
  た: 'ta', ち: 'chi', つ: 'tsu', て: 'te', と: 'to',
  な: 'na', に: 'ni', ぬ: 'nu', ね: 'ne', の: 'no',
  は: 'ha', ひ: 'hi', ふ: 'fu', へ: 'he', ほ: 'ho',
  ま: 'ma', み: 'mi', む: 'mu', め: 'me', も: 'mo',
  や: 'ya', ゆ: 'yu', よ: 'yo',
  ら: 'ra', り: 'ri', る: 'ru', れ: 're', ろ: 'ro',
  わ: 'wa', ゐ: 'i', ゑ: 'e', を: 'wo', ん: 'n',
  が: 'ga', ぎ: 'gi', ぐ: 'gu', げ: 'ge', ご: 'go',
  ざ: 'za', じ: 'ji', ず: 'zu', ぜ: 'ze', ぞ: 'zo',
  だ: 'da', ぢ: 'ji', づ: 'du', で: 'de', ど: 'do',
  ば: 'ba', び: 'bi', ぶ: 'bu', べ: 'be', ぼ: 'bo',
  ぱ: 'pa', ぴ: 'pi', ぷ: 'pu', ぺ: 'pe', ぽ: 'po',
  ヴ: 'vu', ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o',
};

const ARTIST_ALIASES: Record<string, string> = {
  '王菲': 'faye wong', '中島みゆき': 'miyuki nakajima', '山下達郎': 'tatsuro yamashita',
  '宇多田ヒカル': 'utada hikaru', 'スピッツ': 'spitz', 'ゆず': 'yuzu',
};

// 标准化：小写 + 去空白与常见括号/连接符
export const norm = (s: unknown): string =>
  String(s).toLowerCase().replace(/[\s·・'’"「」『』【】()[\]（）~〜\-—_]/g, '');

export function romaji(s: unknown): string {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)!;
    let h = ch;
    if (c >= 0x30A1 && c <= 0x30F6) h = String.fromCodePoint(c - 0x60); // 片假名→平假名
    if (h === 'ー') { const m = out.match(/[aiueo]$/); if (m) out += m[0]; continue; }
    if ('ゃゅょ'.includes(h)) {
      const m = out.match(/([b-df-hj-np-tv-z]+)([aiueo])$/);
      if (!m) continue;
      const cl = m[1];
      const add = cl === 'sh' ? {ゃ: 'sha', ゅ: 'shu', ょ: 'sho'}[h]
        : cl === 'ch' ? {ゃ: 'cha', ゅ: 'chu', ょ: 'cho'}[h]
        : cl === 'j' ? {ゃ: 'ja', ゅ: 'ju', ょ: 'jo'}[h]
        : cl + {ゃ: 'ya', ゅ: 'yu', ょ: 'yo'}[h];
      out = out.slice(0, out.length - m[0].length) + (add ?? ''); continue;
    }
    if ('ぁぃぅぇぉ'.includes(h)) {
      const v = {ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o'}[h];
      const m = out.match(/([b-df-hj-np-tv-z]+)[aiueo]$/);
      if (m && v) out = out.slice(0, -1) + v; else out += v ?? ''; continue;
    }
    if (KANA[h]) { out += KANA[h]; continue; }
    out += ch;
  }
  return out;
}

const WORD_RE = /[^\p{L}\p{N}]+/u;

// 拉丁词组缩写（spitz → s；tatsuro yamashita → ty）
function acronym(s: unknown): string {
  const ws = String(s).normalize('NFKC').toLowerCase().split(WORD_RE).filter(w => /[a-z]/.test(w));
  return ws.length > 1 ? ws.map(w => w[0]).join('') : '';
}

const extrasFor = (s: unknown): string[] => {
  const a = ARTIST_ALIASES[String(s).trim()];
  return a ? [a] : [];
};

function haystackOf(text: unknown): string {
  const lower = String(text).toLowerCase();
  const r = romaji(text);
  const ac = acronym(text);
  return lower + (r !== lower ? ' ' + r.toLowerCase() : '') + (ac ? ' ' + ac : '');
}

// 每条记录的检索串缓存（记录对象随 state 刷新重建，WeakMap 自动失效）
const hayCache = new WeakMap<AlbumRecord, string>();

export function recordHaystack(r: AlbumRecord): string {
  let hay = hayCache.get(r);
  if (!hay) {
    hay = [r.title, r.artist, r.location || '', r.note || '', ...extrasFor(r.artist)]
      .filter(Boolean).map(haystackOf).join(' ');
    hayCache.set(r, hay);
  }
  return hay;
}

export function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({length: n + 1}, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

export const ratio = (a: string, b: string): number => {
  const m = Math.max(a.length, b.length);
  return m ? 1 - lev(a, b) / m : 1;
};

function termScore(q: string, h: string): number {
  if (h.includes(q)) return 1;
  if (q.length >= 4) {
    const words = h.split(/\s+/);
    for (const w of words) {
      if (w.length >= 4) {
        const d = 1 - lev(q, w) / Math.max(q.length, w.length);
        if (d >= 0.72) return d * 0.9;
      }
    }
    const d = 1 - lev(q, h) / Math.max(q.length, h.length);
    if (d >= 0.72) return d * 0.75;
  }
  return 0;
}

// 多词 AND：每个词都要命中；标题完全一致再加分
export function searchScore(r: AlbumRecord, q: string): number {
  const hay = recordHaystack(r);
  const terms = q.split(/\s+/).filter(Boolean).map(t => norm(t));
  let total = 0;
  for (const t of terms) { const s = termScore(t, hay); if (!s) return 0; total += s; }
  return total / terms.length + (q.trim() === norm(r.title) ? 0.5 : 0);
}

export interface MatchHit { r: AlbumRecord; sc: number }

// 录入表单的库内建议：标题命中为主，艺人命中打 0.8 折，取前 5
export function matchRecords(q: string, records: AlbumRecord[]): MatchHit[] {
  const raw = q.trim();
  if (raw.length < 2) return [];
  const qn = norm(raw);
  return records.map(r => {
    let sc = termScore(qn, haystackOf(r.title));
    if (r.title && norm(raw) === norm(r.title)) sc = 1;
    const aSc = termScore(qn, haystackOf(r.artist));
    if (aSc > 0) sc = Math.max(sc, aSc * 0.8);
    return {r, sc};
  }).filter(x => x.sc >= 0.66).sort((a, b) => b.sc - a.sc).slice(0, 5);
}

// 艺人输入的相似名纠错建议
export function artistSuggestions(q: string, records: AlbumRecord[]): string[] {
  const target = norm(q);
  if (target.length < 1) return [];
  const seen = new Set<string>();
  return [...new Set(records.map(r => r.artist))].filter(a => {
    const na = norm(a);
    if (seen.has(na)) return false;
    seen.add(na);
    return na !== target && (na.includes(target) || target.includes(na) || ratio(target, na) >= 0.62);
  }).sort((a, b) => ratio(target, norm(b)) - ratio(target, norm(a))).slice(0, 4);
}
