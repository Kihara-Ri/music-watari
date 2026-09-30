// hash 路由：#domestic / #transit / … 缺省国内库存。
import {useEffect, useState} from 'react';

export function useHashRoute(): string {
  const [page, setPage] = useState(() => location.hash.slice(1) || 'domestic');
  useEffect(() => {
    const on = () => setPage(location.hash.slice(1) || 'domestic');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return page;
}
