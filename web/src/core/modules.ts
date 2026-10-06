// 模块目录只包含静态能力与依赖；用户选择经 AppContext 从服务端读取。
import type {ModuleFlags, StartPage, Status} from '../types';

export const MODULES = [
  {id: 'showcase', name: '收藏展示', desc: '九种封面排列与逐张展示，可选择自己的展示首页。'},
  {id: 'acquisition', name: '购入记录', desc: '记录购买时间、店铺、原币金额与成本。'},
  {id: 'trading', name: '二手交易', desc: '管理上架、成交、待到账与交易历史。'},
  {id: 'circulation', name: '海外周转', desc: '管理海外库存、运输包裹与运费分摊；包含购入记录。'},
] as const;

export const PRESETS: ReadonlyArray<{id: string; name: string; desc: string; enabled: ModuleFlags}> = [
  {id: 'collection', name: '整理收藏', desc: '整理专辑、版本、实物照片和存放位置。', enabled: {acquisition: false, trading: false, circulation: false, showcase: false}},
  {id: 'appreciation', name: '展示收藏', desc: '展示封面、翻阅收藏；购入与交易资料按需开启。', enabled: {acquisition: false, trading: false, circulation: false, showcase: true}},
  {id: 'provenance', name: '收藏与购入', desc: '记住每张专辑什么时候、在哪里买的。', enabled: {acquisition: true, trading: false, circulation: false, showcase: false}},
  {id: 'selling', name: '收藏与交易', desc: '收藏之余，偶尔上架和出售二手专辑。', enabled: {acquisition: true, trading: true, circulation: false, showcase: false}},
  {id: 'overseas', name: '海外周转', desc: '保留海外买入、运回、销售与完整账目。', enabled: {acquisition: true, trading: true, circulation: true, showcase: false}},
];

// 未配置的旧实例维持原有能力；新增的展示模块由用户主动开启。
export const LEGACY_MODULES: ModuleFlags = {acquisition: true, trading: true, circulation: true, showcase: false};

export function normalizeModules(enabled: ModuleFlags): ModuleFlags {
  return {...enabled, showcase: enabled.showcase === true};
}

export function homePage(startPage: StartPage | undefined, modules: ModuleFlags): StartPage {
  return startPage === 'gallery' && modules.showcase ? 'gallery' : 'domestic';
}

export function sameModules(a: ModuleFlags, b: ModuleFlags): boolean {
  return MODULES.every(m => a[m.id] === b[m.id]);
}

export function pageEnabled(page: string, m: ModuleFlags): boolean {
  if (page === 'gallery') return m.showcase;
  if (['overseas', 'transit'].includes(page)) return m.circulation;
  if (['shipping', 'trades'].includes(page)) return m.trading;
  if (page === 'stats') return m.acquisition || m.trading;
  return ['domestic', 'settings', 'trash', 'more', 'ledger'].includes(page);
}

export function statusName(status: Status, m: ModuleFlags): string {
  if (!m.circulation && ['overseas', 'domestic'].includes(status)) return '收藏中';
  return {overseas: '海外库存', transit: '海外在途', domestic: '国内库存', shipping: '售出中', sold: '已售出', trash: '回收站'}[status];
}

export function onShelf(status: Status, page: string, m: ModuleFlags): boolean {
  return page === 'domestic' && !m.circulation
    ? ['overseas', 'domestic', 'transit'].includes(status) : status === page;
}
