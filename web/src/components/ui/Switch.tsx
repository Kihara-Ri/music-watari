// 开关（侧标有无）。受控组件。
export function Switch({on, onToggle}: {on: boolean; onToggle: () => void}) {
  return (
    <button type="button" className={`switch${on ? ' on' : ''}`} role="switch"
            aria-checked={on} onClick={onToggle}>
      <span className="knob"/>
    </button>
  );
}
