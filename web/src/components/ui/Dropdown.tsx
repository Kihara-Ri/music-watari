// 自定义下拉选择（排序 / 交易状态筛选）：按钮 + 浮层 + 键盘导航，
// 不用原生 <select> 以保持视觉一致。
import {useEffect, useRef, useState} from 'react';

export interface DdOption {
  value: string;
  label: string;
}

export function Dropdown({id, value, options, label, onPick}: {
  id: string; value: string; options: DdOption[]; label: string; onPick: (v: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const cur = options.find(o => o.value === value) || options[0];

  useEffect(() => {
    if (open) setActive(options.findIndex(o => o.value === cur.value));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // 键盘选中项滚动进视野
  useEffect(() => {
    if (open && active >= 0) {
      listRef.current?.children[active]?.scrollIntoView({block: 'nearest'});
    }
  }, [active, open]);

  const close = () => { setOpen(false); setActive(-1); };
  const choose = (o: DdOption) => { onPick(o.value); close(); };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      setActive(a => (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
    } else if (e.key === 'Enter' && open && active >= 0) {
      e.preventDefault();
      choose(options[active]);
    }
  };

  return (
    <div className="dd" onKeyDown={onKeyDown}
         onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) close(); }}>
      <button type="button" className="dd-btn" aria-haspopup="listbox" aria-expanded={open}
              aria-controls={`${id}-list`} aria-label={label}
              onClick={() => setOpen(o => !o)}>
        <span className="dd-label">{cur.label}</span>
        <span className="dd-caret" aria-hidden="true"/>
      </button>
      <div className="shop-options dd-list" id={`${id}-list`} role="listbox" aria-label={label}
           hidden={!open} ref={listRef}>
        {options.map(o => (
          <div key={o.value} className="dd-opt" role="option" id={`${id}-opt-${options.indexOf(o)}`}
               aria-selected={o.value === cur.value}
               onPointerDown={e => e.preventDefault()}
               onClick={() => choose(o)}>{o.label}</div>
        ))}
      </div>
    </div>
  );
}
