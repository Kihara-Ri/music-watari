import type {AlbumRecord} from '../types';
import {searchScore} from './search';

export type GalleryMode = 'tiles' | 'waterfall' | 'film' | 'flow' | 'crate' | 'table' | 'fan' | 'isometric' | 'ring';
export const GALLERY_ROAMING_DEFAULTS: Readonly<Record<GalleryMode, number>> = {
  tiles: 8, waterfall: 10, film: 6, flow: 4, crate: 5,
  table: 10, fan: 4, isometric: 4, ring: 4,
};
export type GalleryDensity = 'small' | 'medium' | 'large';
export type GallerySort = 'recent' | 'artist' | 'title' | 'group';
export type GalleryScope = {kind: 'all'} | {kind: 'artist'; artist: string} | {kind: 'group'; groupId: string};
export interface ShowcaseGroup {id: string; name: string; recordIds: string[]}
export interface ShowcaseGroups {revision: number; groups: ShowcaseGroup[]}

export function showcaseGroups(settings: Record<string, unknown>): ShowcaseGroups {
  const raw = settings['showcase-groups-v1'];
  if (!raw || typeof raw !== 'object') return {revision: 0, groups: []};
  const store = raw as Partial<ShowcaseGroups>;
  if (!Number.isInteger(store.revision) || !Array.isArray(store.groups)) return {revision: 0, groups: []};
  return {revision: store.revision!, groups: store.groups.filter(g => g && typeof g.id === 'string'
    && typeof g.name === 'string' && Array.isArray(g.recordIds) && g.recordIds.every(id => typeof id === 'string'))};
}

export const GALLERY_MODES: ReadonlyArray<{value: GalleryMode; label: string; description: string}> = [
  {value: 'tiles', label: '封面墙', description: '像瓷砖一样铺开全部收藏'},
  {value: 'waterfall', label: '瀑布流', description: '错落纵列，可开启缓慢漫游'},
  {value: 'film', label: '胶片', description: '自由滑动胶片，停在任何位置'},
  {value: 'flow', label: '翻阅', description: '当前封面居中，两侧向后展开'},
  {value: 'crate', label: '唱片箱', description: '像从唱片箱中翻出下一张'},
  {value: 'table', label: '桌面铺开', description: '自然散落在桌面，连续向下铺开'},
  {value: 'fan', label: '扇形展开', description: '封面围绕底部支点展开'},
  {value: 'isometric', label: '等距封面墙', description: '沿斜向轨道循环浏览，可开启缓慢漫游'},
  {value: 'ring', label: '环形展架', description: '沿弧形展架转到下一张'},
];

/** 四个中心模式围绕当前封面沿连续轨道排列。 */
export function galleryModeHasFocus(mode: GalleryMode): boolean {
  return ['flow', 'crate', 'fan', 'ring'].includes(mode);
}

export interface GalleryPreferences {
  mode: GalleryMode;
  density: GalleryDensity;
  showTitles: boolean;
  sort: GallerySort;
  currentId: string | null;
  scope: GalleryScope;
  roamingSpeeds: Partial<Record<GalleryMode, number>>;
}

const PREF_KEY = 'album-gallery-v1';

export function readGalleryPreferences(): GalleryPreferences {
  const fallback: GalleryPreferences = {
    mode: 'tiles', density: 'medium', showTitles: false,
    sort: 'recent', currentId: null, scope: {kind: 'all'}, roamingSpeeds: {},
  };
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || 'null') as Partial<GalleryPreferences> | null;
    if (!p || typeof p !== 'object') return fallback;
    const roamingSpeeds: GalleryPreferences['roamingSpeeds'] = {};
    for (const {value} of GALLERY_MODES) {
      const seconds = p.roamingSpeeds?.[value];
      if (typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 2 && seconds <= 30) roamingSpeeds[value] = seconds;
    }
    return {
      roamingSpeeds,
      mode: GALLERY_MODES.some(m => m.value === p.mode) ? p.mode! : fallback.mode,
      density: ['small', 'medium', 'large'].includes(p.density || '') ? p.density! : fallback.density,
      showTitles: typeof p.showTitles === 'boolean' ? p.showTitles : fallback.showTitles,
      sort: ['recent', 'artist', 'title', 'group'].includes(p.sort || '') ? p.sort! : fallback.sort,
      currentId: typeof p.currentId === 'string' ? p.currentId : null,
      scope: p.scope?.kind === 'artist' && typeof p.scope.artist === 'string' ? {kind: 'artist', artist: p.scope.artist}
        : p.scope?.kind === 'group' && typeof p.scope.groupId === 'string' ? {kind: 'group', groupId: p.scope.groupId}
          : {kind: 'all'},
    };
  } catch { return fallback; }
}

export function saveGalleryPreferences(p: GalleryPreferences): void {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); }
  catch { /* 浏览器不允许保存偏好时，本次展示仍可使用。 */ }
}

/** 在途仍属于自己的收藏；成交即进入 shipping，回收站也不参与展示。 */
export function isCollectedRecord(record: AlbumRecord): boolean {
  return record.status === 'domestic' || record.status === 'overseas' || record.status === 'transit';
}

/** 一张实物一条结果，上架状态与是否有封面都不改变收藏范围。 */
export function galleryRecords(records: AlbumRecord[], query: string, sort: GallerySort,
                               scope: GalleryScope = {kind: 'all'}, groups: ShowcaseGroup[] = []): AlbumRecord[] {
  const q = query.trim().toLocaleLowerCase();
  const group = scope.kind === 'group' ? groups.find(g => g.id === scope.groupId) : undefined;
  const members = new Map(group?.recordIds.map((id, i) => [id, i]) ?? []);
  const eligible = records.filter(r => isCollectedRecord(r)
    && (scope.kind === 'all' || scope.kind === 'artist' && r.artist.trim() === scope.artist
      || scope.kind === 'group' && members.has(r.id)));
  const filtered = q ? eligible.filter(r => searchScore(r, q) > 0) : eligible;
  return filtered.sort((a, b) => {
    if (sort === 'group' && group) return members.get(a.id)! - members.get(b.id)!;
    const order = sort === 'artist'
      ? a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title)
      : sort === 'title' ? a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist)
        : b.createdAt.localeCompare(a.createdAt);
    return order || a.id.localeCompare(b.id);
  });
}

export function galleryIndex(records: AlbumRecord[], currentId: string | null): number {
  const found = records.findIndex(r => r.id === currentId);
  return found < 0 ? 0 : found;
}
