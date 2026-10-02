// 外观主题引导：CSP 禁内联脚本，无法在 HTML 里提前写主题，故用阻塞式外链脚本
// 在首帧前解析偏好并设置 <html data-theme>，避免显式选浅色时闪一帧深色（或反之）。
// 偏好存 localStorage（album-theme，与 core/prefs.ts 的键前缀一致）；
// 跟随系统时不设 data-theme，颜色由 tokens.css 的 light-dark() 按 color-scheme 自解析，
// theme-color meta 用双 media 声明原生跟随系统；只有显式选择时才需要 JS 对齐 meta。
// 应用内切换经 window.DDTheme（core/theme.ts 类型化转发），登录页与本应用共用本文件。
// 首帧引导不做过渡（颜色必须首帧即正确）；仅交互切换与系统外观变化时加 .theme-fade
// （base.css 定义的全局颜色过渡窗口，结束即移除，不常驻）。
(function () {
  var KEY = 'album-theme';
  // 与 tokens.css 的 --bg 浅/深值保持一致
  var COLORS = { light: '#f4f5f7', dark: '#0e1014' };
  var FADE_MS = 380; // 略长于 base.css 里 .theme-fade 的 .3s 过渡时长
  var fadeTimer = null;
  var metas = null;
  function resolve(pref) { return pref === 'light' || pref === 'dark' ? pref : 'system'; }
  function stored() {
    try { return localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function syncMetas(mode) {
    if (!metas) metas = [].slice.call(document.querySelectorAll('meta[name="theme-color"]'));
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i];
      var scheme = (m.getAttribute('media') || '').indexOf('dark') >= 0 ? 'dark' : 'light';
      m.setAttribute('content', mode === 'system' ? COLORS[scheme] : COLORS[mode]);
    }
  }
  function applyMode(mode) {
    if (mode === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
  }
  function enableFade() {
    var root = document.documentElement;
    root.classList.add('theme-fade');
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () { root.classList.remove('theme-fade'); }, FADE_MS);
  }
  function boot() {
    var mode = resolve(stored());
    applyMode(mode);
    syncMetas(mode);
  }
  window.DDTheme = {
    get: function () { return resolve(stored()); },
    set: function (pref) {
      try { localStorage.setItem(KEY, resolve(pref)); } catch (e) { /* 存储不可用时仅本次会话生效 */ }
      var mode = resolve(pref);
      enableFade();
      applyMode(mode);
      syncMetas(mode);
    },
  };
  // 跟随系统时，系统外观自动切换（如日落自动转深色）同样渐变
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
    if (resolve(stored()) === 'system') enableFade();
  });
  boot();
})();
