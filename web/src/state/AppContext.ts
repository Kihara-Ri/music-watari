// 全局应用上下文：服务端状态 + 页面视图状态 + 抽屉 / toast 的唯一入口。
// 模块间通信只经这里，杜绝散落的全局变量。

import {createContext, useContext} from 'react';
import type {ReactNode} from 'react';
import type {ThemePref} from '../core/theme';
import type {AlbumRecord, AppState, ModuleFlags, SortMode} from '../types';

export interface DrawerSpec {
  title: string;
  content: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  variant?: 'artist';
  back?: {label: string; run: () => void};
  workspace?: boolean;
  asForm?: boolean;   // 表单类抽屉：内容自带 <form>，撑满抽屉高度
  initialFocus?: 'close'; // 选择面板先浏览，避免自动聚焦搜索框唤起手机键盘
}

// 消息级别：成功（绿）/ 警告（黄）/ 错误（红）
export type ToastKind = 'ok' | 'warn' | 'err';

export interface AppCtx {
  state: AppState;
  modules: ModuleFlags;
  page: string;
  query: string; setQuery(v: string): void;
  sort: SortMode; setSort(v: SortMode): void;
  flip: boolean; setFlip(v: boolean): void;
  tradeFilter: string; setTradeFilter(v: string): void;
  shelfFilter: string; setShelfFilter(v: string): void;
  shelfView: 'list' | 'cards'; setShelfView(v: 'list' | 'cards'): void;
  mobileSelecting: boolean; setMobileSelecting(v: boolean): void;
  selected: ReadonlySet<string>; setSelected(s: Set<string>): void;
  theme: ThemePref; setTheme(v: ThemePref): void;
  rec(id: string): AlbumRecord | undefined;
  refresh(): Promise<void>;
  toast(msg: string, kind?: ToastKind): void;
  openDrawer(spec: DrawerSpec): void;
  /** 请求关闭抽屉（脏表单会先弹确认）。返回 false = 被用户取消，抽屉保持打开。 */
  closeDrawer(force?: boolean): boolean;
  setDrawerDirty(v: boolean): void;
}

export const AppContext = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp 必须在 AppContext.Provider 内使用');
  return ctx;
}
