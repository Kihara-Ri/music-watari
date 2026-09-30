// localStorage 偏好（渠道 / 币种 / 售出平台），键前缀 album-。
export const prefs = {
  get(k: string, d = ''): string { return localStorage.getItem('album-' + k) ?? d; },
  set(k: string, v: string): void { localStorage.setItem('album-' + k, v); },
};
