// 购买渠道组合框：聚焦列出全部历史店铺（图标 + 归并写法 + 次数排序），
// 输入即过滤，可自由输入新店名。品牌图标见 shopIcons.ts。
import {useEffect, useMemo, useRef, useState} from 'react';
import type {AlbumRecord} from '../types';
import {SHOP_ICONS} from './shopIcons';
import {ChevDownIco} from './icons';

export function ShopMark({name}: {name: string}) {
  const s = (name || '').toLowerCase();
  for (const [keys, src] of SHOP_ICONS) {
    if (keys.split('|').some(k => s.includes(k))) return <img src={src} alt=""/>;
  }
  const ch = [...(name || '').trim()][0];
  return ch ? <span className="shop-letter">{ch.toUpperCase()}</span> : null;
}

const normShop = (s: string) => s.toLocaleLowerCase().replace(/[\s\u3000]+/g, '');

// 同店不同写法归并（Disk union/disk union、SHIBUYA 109/SHIBUYA109…）：
// 键为小写去空白，展示名取该店出现最多的写法；排序按归并后的总购买次数降序
function mergeShops(records: AlbumRecord[], defaultShop: string) {
  const groups = new Map<string, {spell: Map<string, number>; total: number}>();
  const add = (s: string, n: number) => {
    if (!s) return;
    const k = normShop(s);
    let g = groups.get(k);
    if (!g) { g = {spell: new Map(), total: 0}; groups.set(k, g); }
    g.spell.set(s, (g.spell.get(s) || 0) + n);
    g.total += n;
  };
  records.forEach(r => add((r.location || '').trim(), 1));
  if (defaultShop && !groups.has(normShop(defaultShop.trim()))) add(defaultShop.trim(), 0);
  return [...groups.values()].map(g => {
    let name = '', best = -1;
    for (const [s, c] of g.spell) if (c > best) { name = s; best = c; }
    return {name, count: g.total};
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh'));
}

export function ShopField({value, records, defaultShop, onChange}: {
  value: string;
  records: AlbumRecord[];
  defaultShop: string;
  onChange: (v: string) => void;
}) {
  const shops = useMemo(() => mergeShops(records, defaultShop), [records, defaultShop]);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  const matches = useMemo(
    () => shops.filter(s => s.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase())),
    [shops, filter]);

  const show = (q = '') => { setFilter(q); setActive(-1); setOpen(true); };
  const close = () => { setOpen(false); setActive(-1); };
  const choose = (name: string) => { onChange(name); close(); };

  useEffect(() => {
    if (open && active >= 0) {
      listRef.current?.children[active]?.scrollIntoView({block: 'nearest'});
    }
  }, [active, open]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { close(); return; }
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      if (!open) { show(); return; }
      if (!matches.length) return;
      setActive(a => (a + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
    } else if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault();
      choose(matches[active].name);
    }
  };

  return (
    <div className="field shop-field"
         onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) close(); }}>
      <label htmlFor="f-location">购买渠道</label>
      <div className="shop-control">
        <span className="shop-ico" aria-hidden="true"><ShopMark name={value}/></span>
        <input id="f-location" value={value} role="combobox" aria-autocomplete="list"
               aria-expanded={open} aria-controls="shop-options" autoComplete="off"
               placeholder="选择已有店铺，或输入新店铺"
               onChange={e => { onChange(e.target.value); show(e.target.value); }}
               onFocus={() => show()}
               onClick={() => { if (!open) show(); }}
               onKeyDown={onKeyDown}/>
        <button type="button" className="shop-toggle" aria-label="展开已有店铺"
                onClick={() => { if (open) close(); else show(); }}>{ChevDownIco}</button>
      </div>
      <div id="shop-options" className="shop-options" role="listbox" aria-label="已有店铺"
           hidden={!open} ref={listRef}>
        {matches.map((s, i) => (
          <div key={s.name} role="option" aria-selected={i === active}
               onPointerDown={e => e.preventDefault()}
               onClick={() => choose(s.name)}>
            <span className="opt-mark"><ShopMark name={s.name}/></span>
            <span>{s.name}</span>
          </div>
        ))}
        {!matches.length && (
          <p className="small-note">
            {shops.length ? '没有匹配店铺，保存后会记住新名称。' : '输入店铺名称，保存后下次可直接选择。'}
          </p>
        )}
      </div>
    </div>
  );
}
