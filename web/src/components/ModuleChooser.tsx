import {useEffect, useState} from 'react';
import {api} from '../core/api';
import {MODULES, PRESETS, sameModules} from '../core/modules';
import {useApp} from '../state/AppContext';
import type {ModuleFlags} from '../types';

export function ModuleChooser({initial = false}: {initial?: boolean}) {
  const app = useApp();
  const [enabled, setEnabled] = useState<ModuleFlags>(initial ? {...PRESETS[0].enabled} : {...app.modules});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!initial) setEnabled({...app.modules}); }, [app.modules.acquisition, app.modules.trading, app.modules.circulation, initial]);

  const toggle = (id: keyof ModuleFlags, on: boolean) => setEnabled(prev => ({
    ...prev, [id]: on,
    ...(id === 'circulation' && on ? {acquisition: true} : {}),
    ...(id === 'acquisition' && !on ? {circulation: false} : {}),
  }));
  const save = async () => {
    setSaving(true); setError('');
    try {
      await api('modules', {enabled});
      await app.refresh();
      app.setSelected(new Set());
      app.setShelfFilter('all');
      app.toast(initial ? '已准备好，添加第一张专辑吧' : '功能模块已更新');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSaving(false); }
  };
  return (
    <div className="module-chooser">
      <div className="module-presets" aria-label="使用方式">
        {PRESETS.map(p => <button type="button" key={p.id} className="module-preset"
          aria-pressed={sameModules(enabled, p.enabled)} disabled={saving}
          onClick={() => setEnabled({...p.enabled})}>
          <strong>{p.name}</strong><span>{p.desc}</span>
        </button>)}
      </div>
      <p className="small-note">基础收藏、照片、搜索、备份和导出始终可用，也可以单独调整下面的模块。</p>
      <div className="module-options">
        {MODULES.map(m => <label className="module-option" key={m.id}>
          <input type="checkbox" checked={enabled[m.id]} disabled={saving}
            onChange={e => toggle(m.id, e.target.checked)}/>
          <span><strong>{m.name}</strong><small>{m.desc}</small></span>
        </label>)}
      </div>
      {!initial ? <p className="small-note">关闭模块只收起相关入口，原有购买、包裹和交易记录全部保留；重新开启后可以继续处理。</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <button type="button" className="primary" disabled={saving || (!initial && app.state.modules?.configured && sameModules(enabled, app.modules))}
        onClick={save}>{saving ? '保存中…' : initial ? '开始使用' : '保存功能选择'}</button>
    </div>
  );
}
