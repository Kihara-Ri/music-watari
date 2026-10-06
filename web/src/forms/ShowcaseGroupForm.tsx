import {useMemo, useState} from 'react';
import type {FormEvent} from 'react';
import {useApp} from '../state/AppContext';
import {api, ApiError} from '../core/api';
import {isCollectedRecord} from '../core/gallery';
import type {ShowcaseGroup, ShowcaseGroups} from '../core/gallery';
import {labelTags} from '../types';
import {GalleryArtwork} from '../components/GalleryMedia';
import {ChevDownIco} from '../components/icons';

export function ShowcaseGroupForm({group, store, onSaved, onDeleted}: {
  group?: ShowcaseGroup; store: ShowcaseGroups; onSaved(id: string): void; onDeleted(id: string): void;
}) {
  const app = useApp();
  const [name, setName] = useState(group?.name ?? '');
  const [ids, setIds] = useState(group?.recordIds ?? []);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const byId = useMemo(() => new Map(app.state.records.map(r => [r.id, r])), [app.state.records]);
  const available = useMemo(() => app.state.records.filter(isCollectedRecord).sort((a, b) =>
    a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title)), [app.state.records]);
  const q = query.trim().toLocaleLowerCase();
  const candidates = available.filter(r => !ids.includes(r.id)
    && (!q || `${r.title} ${r.artist}`.toLocaleLowerCase().includes(q)));
  const change = (next: string[]) => {setIds(next); app.setDrawerDirty(true);};
  const move = (at: number, by: number) => {
    const next = [...ids]; [next[at], next[at + by]] = [next[at + by], next[at]]; change(next);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError('');
    try {
      const result = await api<ShowcaseGroups>('showcase/groups', {action: group ? 'update' : 'create',
        expectedRevision: store.revision, ...(group ? {id: group.id} : {}), name, recordIds: ids});
      const id = group?.id ?? result.groups.find(g => !store.groups.some(old => old.id === g.id))?.id;
      app.setDrawerDirty(false);
      try {await app.refresh();}
      catch {
        app.closeDrawer(true); app.toast('展示组已保存，列表暂未刷新，请刷新页面后选择该组', 'warn'); return;
      }
      if (id) onSaved(id);
      app.closeDrawer(true); app.toast('展示组已保存');
    } catch (err) {
      setError(err instanceof ApiError && err.status === 409
        ? `${err.message}。当前编辑内容仍保留，请重新打开最新的展示组再编辑。`
        : err instanceof Error ? err.message : String(err));
    } finally {setSaving(false);}
  };
  const remove = async () => {
    if (!group || saving || !confirm(`删除展示组「${group.name}」？其中的专辑仍保留在收藏。`)) return;
    setSaving(true); setError('');
    try {
      await api('showcase/groups', {action: 'delete', id: group.id, expectedRevision: store.revision});
      app.setDrawerDirty(false); onDeleted(group.id);
      try {await app.refresh();}
      catch {
        app.closeDrawer(true); app.toast('展示组已删除，列表暂未刷新，请刷新页面', 'warn'); return;
      }
      app.closeDrawer(true); app.toast('展示组已删除');
    } catch (err) {setError(err instanceof Error ? err.message : String(err));}
    finally {setSaving(false);}
  };
  return <form className="showcase-group-form" onSubmit={save}>
    <label className="field"><span>展示组名称</span>
      <input value={name} required maxLength={100} placeholder="例如：夜晚的唱片" disabled={saving}
             onChange={event => {setName(event.target.value); app.setDrawerDirty(true);}}/>
    </label>
    <section className="showcase-group-selection">
      <h3>展示顺序 <span>{ids.length} 张</span></h3>
      <div className="showcase-group-picked">{ids.map((id, i) => {
        const r = byId.get(id);
        return <div key={id} className="showcase-group-record">
          {r ? <GalleryArtwork record={r}/> : <span className="showcase-group-missing">—</span>}
          <div className="showcase-group-record-copy"><strong>{r?.title ?? '已不存在的副本'}</strong>
            <span>{r ? [r.artist, ...labelTags(r)].join(' · ') : '保留的组成员'}{r && !isCollectedRecord(r) ? ' · 当前不展示' : ''}</span></div>
          <div className="showcase-group-reorder">
            <button type="button" className="quiet group-move-up" disabled={saving || i === 0} aria-label={`上移：${r?.title ?? '组成员'}`} onClick={() => move(i, -1)}>{ChevDownIco}</button>
            <button type="button" className="quiet" disabled={saving || i === ids.length - 1} aria-label={`下移：${r?.title ?? '组成员'}`} onClick={() => move(i, 1)}>{ChevDownIco}</button>
            <button type="button" className="quiet" disabled={saving} aria-label={`移出组：${r?.title ?? '组成员'}`} onClick={() => change(ids.filter(value => value !== id))}>×</button>
          </div>
        </div>;
      })}</div>
      {!ids.length ? <p className="gallery-scope-empty">从下面添加专辑，上下移动可排列展示顺序。</p> : null}
    </section>
    <section className="showcase-group-available">
      <input type="search" value={query} placeholder="搜索专辑或艺人，添加到组" aria-label="查找可添加的专辑"
             onChange={event => setQuery(event.target.value)}/>
      <div className="showcase-group-candidates">{candidates.map(r =>
        <button key={r.id} type="button" disabled={saving} className="showcase-group-add" onClick={() => change([...ids, r.id])}
                aria-label={`添加到组：${r.title} · ${[r.artist, ...labelTags(r)].join(' · ')}`}>
          <GalleryArtwork record={r}/><span><strong>{r.title}</strong><small>{[r.artist, ...labelTags(r)].join(' · ')}</small></span><b aria-hidden="true">＋</b>
        </button>)}
        {!candidates.length ? <p className="gallery-scope-empty">{q ? '没有匹配的可添加专辑' : '收藏中的专辑都已加入本组'}</p> : null}
      </div>
    </section>
    {error ? <p className="error" role="alert">{error}</p> : null}
    <div className="showcase-group-actions">
      {group ? <button type="button" className="quiet" disabled={saving} onClick={remove}>删除组</button> : null}
      <button type="submit" className="primary" disabled={saving}>{saving ? '正在保存…' : '保存展示组'}</button>
    </div>
  </form>;
}
