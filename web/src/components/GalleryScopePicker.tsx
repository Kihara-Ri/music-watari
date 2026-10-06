import {useMemo, useState} from 'react';
import type {AlbumRecord} from '../types';
import {isCollectedRecord} from '../core/gallery';
import type {GalleryScope, ShowcaseGroup} from '../core/gallery';
import {Seg} from './ui/Seg';

export function GalleryScopePicker({records, groups, scope, onSelect, onCreate, onEdit}: {
  records: AlbumRecord[]; groups: ShowcaseGroup[]; scope: GalleryScope;
  onSelect(scope: GalleryScope): void; onCreate(): void; onEdit(group: ShowcaseGroup): void;
}) {
  const [section, setSection] = useState(scope.kind === 'group' ? 'groups' : 'artists');
  const [query, setQuery] = useState('');
  const eligible = useMemo(() => records.filter(isCollectedRecord), [records]);
  const artists = useMemo(() => {
    const counts = new Map<string, number>();
    eligible.forEach(r => {const name = r.artist.trim(); counts.set(name, (counts.get(name) ?? 0) + 1);});
    return [...counts].sort(([a], [b]) => a.localeCompare(b));
  }, [eligible]);
  const ids = useMemo(() => new Set(eligible.map(r => r.id)), [eligible]);
  const q = query.trim().toLocaleLowerCase();
  return <div className="gallery-scope-picker">
    <button type="button" className={`gallery-scope-row${scope.kind === 'all' ? ' is-selected' : ''}`}
            aria-pressed={scope.kind === 'all'} onClick={() => onSelect({kind: 'all'})}>
      <strong>全部收藏</strong><span>{eligible.length} 张</span>
    </button>
    <Seg options={[{value: 'artists', label: '艺人'}, {value: 'groups', label: '自定义组'}]}
         value={section} onValue={setSection} ariaLabel="展示范围类别"/>
    <input type="search" placeholder={section === 'artists' ? '查找艺人' : '查找展示组'}
           aria-label={section === 'artists' ? '查找艺人' : '查找展示组'} value={query}
           onChange={event => setQuery(event.target.value)}/>
    {section === 'artists' ? <div className="gallery-scope-list">
      {artists.filter(([name]) => name.toLocaleLowerCase().includes(q)).map(([name, count]) =>
        <button key={name} type="button" className={`gallery-scope-row${scope.kind === 'artist' && scope.artist === name ? ' is-selected' : ''}`}
                aria-pressed={scope.kind === 'artist' && scope.artist === name} onClick={() => onSelect({kind: 'artist', artist: name})}>
          <strong>{name}</strong><span>{count} 张</span>
        </button>)}
      {!artists.some(([name]) => name.toLocaleLowerCase().includes(q)) ? <p className="gallery-scope-empty">没有匹配的艺人</p> : null}
    </div> : <>
      <button type="button" className="gallery-group-create" onClick={onCreate}>＋ 新建展示组</button>
      <div className="gallery-scope-list">{groups.filter(g => g.name.toLocaleLowerCase().includes(q)).map(g =>
        <div key={g.id} className="gallery-group-choice">
          <button type="button" className={`gallery-scope-row${scope.kind === 'group' && scope.groupId === g.id ? ' is-selected' : ''}`}
                  aria-pressed={scope.kind === 'group' && scope.groupId === g.id} onClick={() => onSelect({kind: 'group', groupId: g.id})}>
            <strong>{g.name}</strong><span>{g.recordIds.filter(id => ids.has(id)).length} 张</span>
          </button>
          <button type="button" className="quiet" aria-label={`编辑展示组：${g.name}`} onClick={() => onEdit(g)}>编辑</button>
        </div>)}
      {!groups.length ? <p className="gallery-scope-empty">挑选专辑组成一个展示组，例如「夜晚的唱片」。</p> : null}
      {groups.length && !groups.some(g => g.name.toLocaleLowerCase().includes(q)) ? <p className="gallery-scope-empty">没有匹配的展示组</p> : null}
      </div>
    </>}
  </div>;
}
