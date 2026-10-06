import {GALLERY_MODES} from '../core/gallery';
import type {GalleryMode} from '../core/gallery';

/** 布局缩略图用于选择样式；专辑数据仍只在实际舞台中渲染。 */
export function GalleryModePicker({mode, onSelect}: {mode: GalleryMode; onSelect: (mode: GalleryMode) => void}) {
  return <div className="gallery-mode-picker">
    <p className="small-note">选择喜欢的排列方式。收藏和展示顺序会保留。</p>
    <div className="gallery-mode-grid" aria-label="展示方式">
      {GALLERY_MODES.map(option => <button key={option.value} type="button"
        className="gallery-mode-choice" aria-pressed={mode === option.value}
        onClick={() => onSelect(option.value)}>
        <span className={`gallery-mode-preview gallery-mode-preview--${option.value}`} aria-hidden="true">
          {Array.from({length: 9}, (_, i) => <i key={i}/>)}
        </span>
        <span className="gallery-mode-name">{option.label}{mode === option.value ? <span aria-hidden="true"> ✓</span> : null}</span>
        <small>{option.description}</small>
      </button>)}
    </div>
  </div>;
}
