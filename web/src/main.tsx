// 入口：按层顺序加载样式（tokens → base → 布局 → 组件 → 各页面模块），挂载应用。
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/pagetransition.css';
import './styles/components.css';
import './styles/album-summary.css';
import './styles/shelf.css';
import './styles/sales.css';
import './styles/shipments.css';
import './styles/stats.css';
import './styles/settings.css';
import './styles/more.css';
import './styles/drawer.css';
import './styles/photos.css';
import './styles/recognition.css';
import './styles/artists.css';
import './styles/artist-entry.css';
import './styles/gallery.css';
import './styles/gallery-roaming.css';
import './styles/gallery-picker.css';
import './styles/gallery-stage.css';
import './styles/gallery-orbit.css';
import './styles/gallery-fan.css';
import './styles/gallery-continuous.css';
import './styles/gallery-film-navigator.css';
import './styles/gallery-groups.css';
import './styles/gallery-focus.css';
import './styles/gallery-case.css';
import './styles/gallery-viewport.css';
import './styles/login.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App/>
  </StrictMode>,
);
