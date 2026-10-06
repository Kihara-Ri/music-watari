// 保留空路由，待服务端状态到达后由应用选择用户设置的首页。
import {useEffect, useState} from 'react';

export function useHashRoute(): string {
  const [page, setPage] = useState(() => location.hash.slice(1));
  useEffect(() => {
    const on = () => setPage(location.hash.slice(1));
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return page;
}
