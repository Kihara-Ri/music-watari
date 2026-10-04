// API 数据模型：与 storage.py 的 state() 输出一一对应。
// 金额一律是字符串（服务端 Decimal 量化到分），显示时再转 Number。

export type Status = 'overseas' | 'transit' | 'domestic' | 'shipping' | 'sold' | 'trash';
export type SaleStatus = 'shipping' | 'complete' | 'cancelled' | 'returned' | 'refunded';
export type ShipmentStatus = 'transit' | 'arrived' | 'cancelled';
export type Currency = 'JPY' | 'CNY';
export type SortMode = 'new' | 'cost' | 'artist';

export interface CoverSource {
  title: string;
  artist: string;
  year?: string;
}

export interface AlbumRecord {
  id: string;
  title: string;
  artist: string;
  status: Status;
  date: string;
  currency: Currency;
  price: string;            // '' 表示待补
  rate?: string;            // 100日元兑人民币（state() 时由后端补）
  fees: string;
  actual: string;
  cost: string | null;      // null = 成本待补
  cover: string;            // 封面引用（/api/cover/<内容哈希>.<ext>）或 ''
  coverSource?: CoverSource;
  location: string;
  version: string;
  pressing: string;
  obi: string;
  note: string;
  noteAlbum: string;
  photoCount: number;
  revision: number;
  createdAt: string;
  shipmentId?: string;
  saleId?: string;
  previousStatus?: Status;
  listed?: boolean;         // 持有副本的上架标记，与位置和交易状态分开
  listingChannel?: string;
  listingUrl?: string;
  sourceId?: string;
  releaseYear?: string;
  rawRemark?: string;
  storage?: string;         // 实物存放位置，与购买渠道 location 分开
  releaseInfo?: ReleaseInfo;
  listingDescription?: string;
  recognition?: Pick<RecognitionResult, 'model' | 'at' | 'evidence' | 'sources' | 'warnings'>;
}

export interface ReleaseInfo {
  catalogNumber?: string; barcode?: string; label?: string; country?: string;
  releaseDate?: string; edition?: string; format?: string; discCount?: string;
  matrix?: string; extras?: string; observations?: string; tracklist?: string[];
}

export interface RecognitionFields {
  title?: string; artist?: string; price?: string; version?: string; pressing?: string;
  obi?: string; note?: string; releaseInfo?: ReleaseInfo; listingDescription?: string;
  cover?: string; coverSource?: CoverSource;
}

export interface ReleaseCandidate {
  id: string; title: string; artist: string; releaseInfo: ReleaseInfo;
  identifierMatch: boolean; url: string;
}

export interface RecognitionResult {
  fields: RecognitionFields;
  evidence: {field: string; value: string; photo: number; note: string}[];
  warnings: string[]; sources: {title: string; url: string}[];
  candidates: ReleaseCandidate[]; model: string; at: string;
}

export interface ImportGroup {
  id: string; photoIds: string[]; fields: RecognitionFields; protected: string[];
  status: 'idle' | 'queued' | 'running' | 'done' | 'error'; error?: string;
  result?: RecognitionResult; excluded: boolean; reviewed: boolean; savedId?: string;
}

export interface ImportDraft {
  id: string; revision: number; createdAt: string; updatedAt: string;
  common: {date: string; currency: Currency; location: string; storage: string; status: 'domestic' | 'overseas'};
  photos: {id: string; name: string; ext: string; url: string}[]; groups: ImportGroup[];
}

export interface VisionConfig {
  baseUrl: string; model: string; concurrency: number; lookup: boolean;
  hasKey: boolean; configured: boolean;
}

export interface SaleItem {
  recordId: string;
  gross: string;
  fees: string;
  postage: string;
  refund: string;
  net: string;
  profit: string | null;
  grossOriginal?: string;   // 日元售出：原币金额（人民币折算后留存，同运费口径）
  feesOriginal?: string;
  postageOriginal?: string;
}

export interface Sale {
  id: string;
  date: string;
  status: SaleStatus;
  receivedDate: string;
  refundDate?: string;
  gross: string;
  fees: string;
  postage: string;
  currency?: Currency;
  grossOriginal?: string;
  feesOriginal?: string;
  postageOriginal?: string;
  address: string;
  note: string;
  channel: string;
  orderId: string;
  createdAt: string;
  items: SaleItem[];
}

export interface ShipmentItem {
  recordId: string;
  fee: string;
  feeOriginal?: string;
}

export interface Shipment {
  id: string;
  method: string;
  cost: string;
  currency?: Currency;
  costOriginal?: string;
  date: string;
  note: string;
  status: ShipmentStatus;
  arrivedDate: string;
  createdAt: string;
  items: ShipmentItem[];
}

export interface AuditEntry {
  at: string;
  action: string;
}

export interface BackupStatus {
  last: string | null;
  count: number;
  error: string;
}

export interface AppState {
  format: 'album-ledger';
  schema: number;
  createdAt: string;
  records: AlbumRecord[];
  sales: Sale[];
  shipments: Shipment[];
  audit: AuditEntry[];
  settings: Record<string, unknown>;
  modules?: {enabled: ModuleFlags; configured: boolean; needsSetup: boolean}; // 旧运行进程尚未重启时可能缺失
  rateService?: { days: number; latest: string | null };
  service?: { login: boolean; version?: string; backup: BackupStatus };
}

export interface ModuleFlags {
  acquisition: boolean;
  trading: boolean;
  circulation: boolean;
}

export interface BackupFile {
  format: 'album-ledger';
  createdAt: string;
  records: AlbumRecord[];
  sales: Sale[];
  shipments?: Shipment[];
}

export const STATUS_NAMES: Record<Status, string> = {
  overseas: '海外库存', transit: '海外在途', domestic: '国内库存',
  shipping: '售出中', sold: '已售出', trash: '回收站',
};

export const SALE_NAMES: Record<SaleStatus, string> = {
  shipping: '售出中', complete: '已售出', cancelled: '已撤销',
  returned: '已退货', refunded: '已退款',
};

// 碟盒 + 版次合并成卡片小标签；日版带侧标时拼成「日版·带侧标」
export function labelTags(r: AlbumRecord): string[] {
  const p = r.pressing ? (r.pressing === '日版' && r.obi ? `${r.pressing}·${r.obi}` : r.pressing) : '';
  return [p, r.version].filter(Boolean);
}
