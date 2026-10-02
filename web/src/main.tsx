// 入口：按层顺序加载样式（tokens → base → 布局 → 组件 → 各页面模块），挂载应用。
import './styles/tokens.css';
import './styles/base.css';
import './styles/layout.css';
import './styles/components.css';
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
import './styles/login.css';
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App/>
  </StrictMode>,
);
