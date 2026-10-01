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
  cover: string;            // data URL 或 ''
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
  listed?: boolean;         // 国内库存的附加标记：已挂闲鱼在售
  sourceId?: string;
  releaseYear?: string;
  rawRemark?: string;
  storage?: string;         // 实物存放位置，与购买渠道 location 分开
}

export interface SaleItem {
  recordId: string;
  gross: string;
  fees: string;
  postage: string;
  refund: string;
  net: string;
  profit: string | null;
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
