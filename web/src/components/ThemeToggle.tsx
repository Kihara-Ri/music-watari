// 外观切换：浅色 → 深色 → 跟随系统 三态循环（用户已定：不做下拉）。
// 桌面端放页头右上角（withLabel=false 图标按钮），手机端在「更多 · 管理」
// 与「设置与备份」同级的行内（withLabel=true）。偏好读写经 core/theme → static/theme.js。
import {useApp} from '../state/AppContext';
import type {ThemePref} from '../core/theme';

const MODES: {value: ThemePref; label: string; glyph: string; next: ThemePref}[] = [
  {value: 'light', label: '浅色', glyph: '○', next: 'dark'},
  {value: 'dark', label: '深色', glyph: '●', next: 'system'},
  {value: 'system', label: '跟随系统', glyph: '◐', next: 'light'},
];

export function ThemeToggle({withLabel = false}: {withLabel?: boolean}) {
  const {theme, setTheme} = useApp();
  const cur = MODES.find(m => m.value === theme) ?? MODES[2];
  const next = MODES.find(m => m.value === cur.next)!;
  const switchMode = () => setTheme(cur.next);
  const hint = `外观：${cur.label}，点击切换为${next.label}`;
  if (withLabel) {
    return (
      <button type="button" className="theme-row" onClick={switchMode} aria-label={hint}>
        <span className="nav-ico" aria-hidden="true">{cur.glyph}</span>
        <span><strong>外观</strong><small>{cur.label} · 点击切换为{next.label}</small></span>
        <span className="more-arrow" aria-hidden="true">›</span>
      </button>
    );
  }
  return (
    <button type="button" className="theme-toggle" onClick={switchMode} title={hint} aria-label={hint}>
      <span aria-hidden="true">{cur.glyph}</span>
    </button>
  );
}
