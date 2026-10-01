// 外观偏好：读写逻辑在 static/theme.js（阻塞式引导脚本，保证首帧前生效，
// CSP 禁内联脚本无法写在 HTML 里）；这里只做类型化转发给 React 状态层。
export type ThemePref = 'light' | 'dark' | 'system';

declare global {
  interface Window {
    DDTheme?: { get(): ThemePref; set(pref: ThemePref): void };
  }
}

export const themePref = (): ThemePref => window.DDTheme?.get() ?? 'system';
export const applyThemePref = (pref: ThemePref): void => window.DDTheme?.set(pref);
