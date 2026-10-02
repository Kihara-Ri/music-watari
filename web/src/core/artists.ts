// 艺人资料与作品目录：与服务端 server/artists.py 的归一化输出一一对应。
// 组件只消费这里的类型与请求封装，不接触 MusicBrainz 原始 JSON。
import {api, ApiError} from './api';
import type {AlbumRecord} from '../types';

export type CatalogCategory = 'album' | 'ep' | 'single' | 'live' | 'compilation' | 'other';
export type ResolutionStatus = 'resolved' | 'ambiguous' | 'not_found' | 'unavailable';
export type CacheState = 'fresh' | 'stale' | 'missing';

export interface LifeSpan {
  begin: string | null;
  end: string | null;
  ended: boolean | null;
}

export interface ArtistProfile {
  mbid: string;
  name: string;
  aliases: string[];
  type: string | null;
  area: string | null;
  lifeSpan: LifeSpan;
  genres: string[];
  disambiguation: string | null;
  sourceUrl: string;
}

export interface ArtistWork {
  mbid: string;
  title: string;
  firstReleaseDate: string | null;
  primaryType: string | null;
  secondaryTypes: string[];
  category: CatalogCategory;
  artistMbids: string[];
  artworkUrl?: string | null;  // 仅碟渡自己的图片 API（当前由前端按 mbid 构造）
  sourceUrl: string;
}

export interface SourceState {
  fetchedAt: string | null;
  cache: CacheState;
  refreshSuggested: boolean;
  error: string | null;
}

export interface ArtistCandidate {
  mbid: string;
  name: string;
  aliases: string[];
  type: string | null;
  area: string | null;
  disambiguation: string | null;
  score: number | null;
  hasEvidence: boolean | null;
}

export interface ResolveResult {
  status: ResolutionStatus;
  artist: string;
  binding?: IdentityInfo;
  candidates: ArtistCandidate[];
  evidenceComplete: boolean;
  searchCount?: number | null;
  error?: string;
}

export interface IdentityInfo {
  artistMbid: string;
  sourceName: string;
  method: 'manual' | 'corroborated';
  confirmedAt: string;
}

export interface CollectionRecord {
  id: string;
  title: string;
  status: AlbumRecord['status'];
  cover: string;
  version: string;
  pressing: string;
  obi: string;
}

export interface ProfileResponse {
  artist: string;
  status: 'bound' | 'needs_resolution';
  profile: ArtistProfile | null;
  identityError: string | null;
  identities: IdentityInfo | null;
  collection: {counts: {holding: number; shipping: number; sold: number}; records: CollectionRecord[]};
  workLinks: Record<string, WorkLinkInfo>;
  sourceState: SourceState;
}

export interface WorkLinkInfo {
  releaseGroupMbid: string;
  artistMbid: string;
  state: 'confirmed' | 'stale';
}

export interface CatalogPage {
  artistMbid: string;
  roundId: string | null;
  offset: number;
  returned: number;
  total: number | null;
  nextOffset: number | null;
  works: ArtistWork[];
  complete: boolean;
  roundError: string | null;
  sourceState: SourceState;
}

export const CATEGORY_LABELS: Record<CatalogCategory, string> = {
  album: '专辑', ep: 'EP', single: '单曲', live: '现场', compilation: '精选', other: '其他',
};

export const CATEGORY_ORDER: CatalogCategory[] = ['album', 'ep', 'single', 'live', 'compilation', 'other'];

const ARTIST_TYPE_NAMES: Record<string, string> = {
  Person: '个人艺人', Group: '组合', Orchestra: '管弦乐团', Choir: '合唱团',
  Character: '角色', Other: '其他',
};

const WORK_TYPE_NAMES: Record<string, string> = {
  Album: '专辑', EP: 'EP', Single: '单曲', Compilation: '精选', Live: '现场', Remix: '混音',
  Soundtrack: '原声', Demo: '小样', Interview: '访谈', 'DJ-mix': '连续混音', Mixtape: '混音带',
  'Field Recording': '田野录音',
};

export function artistTypeText(type: string | null): string | null {
  if (!type) return null;
  return ARTIST_TYPE_NAMES[type] ?? type;
}

export function workTypeText(work: ArtistWork): string | null {
  const parts = [work.primaryType ? WORK_TYPE_NAMES[work.primaryType] ?? work.primaryType : null,
    ...work.secondaryTypes.map(s => WORK_TYPE_NAMES[s] ?? s)];
  const text = parts.filter(Boolean).join(' · ');
  return text || null;
}

/** Person 显示 出生/逝世；Group 显示 成立/解散；其他类型不展示 life-span（数据保留不解读）。 */
export function lifeSpanText(type: string | null, span: LifeSpan): [string, string][] {
  if (type === 'Person') {
    return ([['出生', span.begin], ['逝世', span.end]] as [string, string | null][])
      .filter(([, v]) => !!v) as [string, string][];
  }
  if (type === 'Group') {
    return ([['成立', span.begin], ['解散', span.end]] as [string, string | null][])
      .filter(([, v]) => !!v) as [string, string][];
  }
  return [];
}

/** 与服务端 strict_key 同口径：NFKC + 小写 + 空白归一（不删标点）。 */
export function strictTitle(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
}

export function workSortKey(w: ArtistWork): string {
  return `${w.firstReleaseDate ?? '9999-12-31'}\u0000${w.title.toLowerCase()}\u0000${w.mbid}`;
}

export function dedupeWorks(works: ArtistWork[]): ArtistWork[] {
  const seen = new Map<string, ArtistWork>();
  for (const w of works) if (!seen.has(w.mbid)) seen.set(w.mbid, w);
  return [...seen.values()].sort((a, b) => workSortKey(a).localeCompare(workSortKey(b)));
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function statusOf(error: unknown): number | null {
  return error instanceof ApiError && error.status ? error.status : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const qs = (params: Record<string, string | number | boolean | undefined>): string => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') q.set(k, String(v));
  }
  const text = q.toString();
  return text ? `?${text}` : '';
};

export const artistsApi = {
  resolve: (artist: string, opts?: {searchName?: string; force?: boolean; signal?: AbortSignal}) =>
    api<ResolveResult>('artists/resolve', {artist, searchName: opts?.searchName || undefined,
                                           force: opts?.force || undefined},
                       {signal: opts?.signal}),
  bind: (artist: string, artistMbid: string, expectedArtistMbid: string | null, signal?: AbortSignal) =>
    api<{ok: true; binding: IdentityInfo}>('artists/bind',
      {artist, artistMbid, expectedArtistMbid}, {signal}),
  profile: (artist: string, opts?: {refresh?: boolean; signal?: AbortSignal}) =>
    api<ProfileResponse>('artists/profile' + qs({artist, refresh: opts?.refresh ? 1 : undefined}),
                         undefined, {signal: opts?.signal}),
  catalog: (artist: string, opts?: {offset?: number; refresh?: boolean; roundId?: string | null;
                                    signal?: AbortSignal}) =>
    api<CatalogPage>('artists/catalog' + qs({artist, offset: opts?.offset ?? 0,
                                             refresh: opts?.refresh ? 1 : undefined,
                                             roundId: opts?.roundId || undefined}),
                     undefined, {signal: opts?.signal}),
  workLink: (body: {artist: string; recordId: string; releaseGroupMbid: string;
                    expectedReleaseGroupMbid: string | null; recordArtist: string; recordTitle: string},
             signal?: AbortSignal) =>
    api<{ok: true; link: WorkLinkInfo}>('artists/work-link', body, {signal}),
  workUnlink: (recordId: string, expectedReleaseGroupMbid: string, signal?: AbortSignal) =>
    api<{ok: true}>('artists/work-unlink', {recordId, expectedReleaseGroupMbid}, {signal}),
  artworkUrl: (mbid: string): string => `/api/artists/artwork/${mbid}`,
};
