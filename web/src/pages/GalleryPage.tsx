import {useEffect, useMemo, useRef, useState} from 'react';
import {useApp} from '../state/AppContext';
import {GALLERY_MODES, GALLERY_ROAMING_DEFAULTS, galleryIndex, galleryModeHasFocus, galleryRecords, readGalleryPreferences, saveGalleryPreferences, showcaseGroups} from '../core/gallery';
import type {GalleryDensity, GalleryPreferences, GallerySort, GalleryScope, ShowcaseGroup} from '../core/gallery';
import {PageHead} from '../components/PageHead';
import {GalleryStage} from '../components/GalleryStage';
import {GalleryFocus} from '../components/GalleryFocus';
import {GalleryModePicker} from '../components/GalleryModePicker';
import {GalleryScopePicker} from '../components/GalleryScopePicker';
import {GalleryRoamingSwitch, GalleryRoamingSpeed} from '../components/GalleryRoamingControls';
import {Dropdown} from '../components/ui/Dropdown';
import {Seg} from '../components/ui/Seg';
import {ChevDownIco} from '../components/icons';
import {openArtistDrawer} from '../forms/ArtistDrawer';
import {openDetail} from '../forms/DetailDrawer';
import {ShowcaseGroupForm} from '../forms/ShowcaseGroupForm';

const SORTS = [
  {value: 'recent', label: '最近加入'}, {value: 'artist', label: '按艺人'}, {value: 'title', label: '按专辑名'},
];

export function GalleryPage() {
  const app = useApp();
  const [preferences, setPreferences] = useState(readGalleryPreferences);
  const scope = preferences.scope;
  const [query, setQuery] = useState('');
  const [immersive, setImmersive] = useState(false);
  const [adjusting, setAdjusting] = useState(false);
  const [roaming, setRoaming] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const ownsFullscreen = useRef(false);
  const mounted = useRef(true);
  const requestedFullscreen = useRef(false);
  const groups = useMemo(() => showcaseGroups(app.state.settings), [app.state.settings]);
  const records = useMemo(() => galleryRecords(app.state.records, query, preferences.sort, preferences.scope, groups.groups),
    [app.state.records, query, preferences.sort, preferences.scope, groups.groups]);
  const currentId = records[galleryIndex(records, preferences.currentId)]?.id || null;
  const updatePreference = (patch: Partial<GalleryPreferences>) => setPreferences(p => ({...p, ...patch}));
  const pick = (id: string) => updatePreference({currentId: id});
  const modeLabel = GALLERY_MODES.find(m => m.value === preferences.mode)!.label;
  const roamingSeconds = preferences.roamingSpeeds[preferences.mode] ?? GALLERY_ROAMING_DEFAULTS[preferences.mode];
  const scopeLabel = scope.kind === 'artist' ? scope.artist
    : scope.kind === 'group' ? groups.groups.find(g => g.id === scope.groupId)?.name ?? '展示组'
      : '全部收藏';
  const sorts = preferences.scope.kind === 'group' ? [{value: 'group', label: '组内顺序'}, ...SORTS] : SORTS;

  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  const chooseMode = () => {
    app.openDrawer({title: '选择展示方式', wide: true,
      content: <GalleryModePicker mode={preferences.mode} onSelect={mode => {
        updatePreference({mode}); app.closeDrawer();
      }}/>,
    });
  };

  const editGroup = (group?: ShowcaseGroup) => {
    app.openDrawer({title: group ? '编辑展示组' : '新建展示组', wide: true,
      content: <ShowcaseGroupForm group={group} store={groups} onSaved={id => {
        setQuery(''); updatePreference({scope: {kind: 'group', groupId: id}, sort: 'group'});
      }} onDeleted={id => setPreferences(p => p.scope.kind === 'group' && p.scope.groupId === id
        ? {...p, scope: {kind: 'all'}, sort: p.sort === 'group' ? 'recent' : p.sort} : p)}/>,
    });
  };
  const chooseScope = () => {
    app.openDrawer({title: '选择展示范围', wide: true, initialFocus: 'close',
      content: <GalleryScopePicker records={app.state.records} groups={groups.groups} scope={preferences.scope}
        onSelect={(scope: GalleryScope) => {
          updatePreference({scope, sort: scope.kind === 'group' ? 'group' : preferences.sort === 'group' ? 'recent' : preferences.sort});
          app.closeDrawer();
        }} onCreate={() => editGroup()} onEdit={editGroup}/>,
    });
  };

  useEffect(() => { saveGalleryPreferences(preferences); }, [preferences]);
  useEffect(() => {
    if (scope.kind === 'group' && !groups.groups.some(g => g.id === scope.groupId)) {
      setPreferences(p => ({...p, scope: {kind: 'all'}, sort: p.sort === 'group' ? 'recent' : p.sort}));
    }
  }, [groups.groups, scope]);

  // 数据刷新、筛选移除了当前副本时，只落到一张明确存在的结果。
  useEffect(() => {
    if (currentId && currentId !== preferences.currentId) setPreferences(p => ({...p, currentId}));
  }, [currentId, preferences.currentId]);

  const exitImmersive = () => {
    setImmersive(false);
    requestedFullscreen.current = false;
    if (ownsFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    ownsFullscreen.current = false;
  };
  const enterImmersive = () => {
    setImmersive(true);
    // 整个应用进入全屏，抽屉/灯箱仍处于可见树中；不支持时仍可隐藏导航展示。
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      requestedFullscreen.current = true;
      void document.documentElement.requestFullscreen().then(() => {
        if (!mounted.current || !requestedFullscreen.current) {
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
          return;
        }
        ownsFullscreen.current = true;
      }).catch(() => {});
    }
  };
  useEffect(() => {
    mounted.current = true;
    const onFullscreen = () => {
      if (ownsFullscreen.current && !document.fullscreenElement) {ownsFullscreen.current = false; setImmersive(false);}
    };
    document.addEventListener('fullscreenchange', onFullscreen);
    return () => {
      mounted.current = false;
      requestedFullscreen.current = false;
      document.removeEventListener('fullscreenchange', onFullscreen);
      if (ownsFullscreen.current && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, []);
  useEffect(() => {
    if (!immersive) return;
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.key !== 'Escape' || document.getElementById('panel') || document.getElementById('lightbox') || document.querySelector('dialog[open]')) return;
      event.preventDefault(); exitImmersive();
    };
    document.addEventListener('keydown', onEscape);
    return () => document.removeEventListener('keydown', onEscape);
  }, [immersive]);

  const focus = (id: string) => {
    pick(id);
    const ids = records.map(r => r.id);
    const restore = (recordId: string) => focus(recordId);
    app.openDrawer({
      title: '收藏展示', wide: true,
      content: <GalleryFocus key={id} ids={ids} initialId={id} onPick={pick}
        onArtist={(artist, recordId) => openArtistDrawer(app, artist,
          {back: {label: '返回展示', run: () => restore(recordId)}})}
        onDetail={recordId => openDetail(app, recordId, {label: '返回展示', run: () => restore(recordId)})}/>,
    });
  };

  return <div className={`gallery-page${immersive ? ' is-immersive' : ''}`}>
    <PageHead title="收藏展示" desc="把收藏铺开，慢慢看。"
              actions={<button type="button" className="quiet" onClick={immersive ? exitImmersive : enterImmersive}>
                {immersive ? '退出沉浸' : '沉浸展示'}
              </button>}/>
    <div className="gallery-controls">
      <div className="gallery-filters">
        <div className="gallery-filter-inputs">
          <button type="button" className="gallery-scope-trigger" onClick={chooseScope} aria-haspopup="dialog"
                  aria-label={`展示范围：${scopeLabel}`} title={scopeLabel}>
            <strong>{scopeLabel}</strong><span className="dd-caret" aria-hidden="true">{ChevDownIco}</span>
          </button>
          <label className="gallery-search"><span className="gallery-visually-hidden">搜索收藏</span>
            <input type="search" placeholder="搜索专辑或艺人" value={query} onChange={e => setQuery(e.target.value)}/>
          </label>
        </div>
        <div className="gallery-toolbar">
          <button type="button" className="gallery-mode-trigger" onClick={chooseMode} aria-haspopup="dialog"
                  aria-label={`展示方式：${modeLabel}`}>
            <strong>{modeLabel}</strong><span className="dd-caret" aria-hidden="true">{ChevDownIco}</span>
          </button>
          <span className="gallery-count" role="status" aria-atomic="true"
                title={`${records.length} 张${query.trim() ? '匹配的' : ''}收藏`}>
            {records.length} 张<span className="gallery-visually-hidden">{query.trim() ? '匹配的收藏' : '收藏'}</span>
          </span>
          <button type="button" className="gallery-adjust-trigger" aria-expanded={adjusting}
            aria-controls="gallery-adjustments" onClick={() => setAdjusting(v => !v)}>
            展示设置<span className="dd-caret" aria-hidden="true">{ChevDownIco}</span>
          </button>
          <GalleryRoamingSwitch enabled={roaming} disabled={!records.length && !roaming} onToggle={() => setRoaming(v => !v)}/>
          <a className="gallery-manage-link" href="#domestic" aria-label="管理收藏" title="管理收藏">管理</a>
        </div>
      </div>
      <div id="gallery-adjustments" className="gallery-adjustments" hidden={!adjusting}>
        <div className="gallery-setting"><span>展示顺序</span>
          <Dropdown id="gallery-sort" options={sorts} value={preferences.sort === 'group' && preferences.scope.kind !== 'group' ? 'recent' : preferences.sort} label="展示顺序"
            onPick={v => updatePreference({sort: v as GallerySort})}/>
        </div>
        {['tiles', 'waterfall', 'film', 'table', 'isometric'].includes(preferences.mode) ? <>
          <div className="gallery-setting"><span>封面大小</span>
            <Seg options={[{value: 'small', label: '小'}, {value: 'medium', label: '中'}, {value: 'large', label: '大'}]}
              value={preferences.density} ariaLabel="封面大小"
              onValue={v => updatePreference({density: v as GalleryDensity})}/>
          </div>
          {preferences.mode === 'tiles' || preferences.mode === 'table' ? <label className="gallery-check"><input type="checkbox" checked={preferences.showTitles}
            onChange={e => updatePreference({showTitles: e.target.checked})}/>显示标题</label>
            : preferences.mode === 'waterfall' ? <span className="gallery-waterfall-note">标题随封面错落排列</span> : null}
        </> : null}
        {roaming ? <div className="gallery-setting gallery-roaming-setting">
          <span>{galleryModeHasFocus(preferences.mode) ? '切换间隔' : '漫游速度'}</span>
          <GalleryRoamingSpeed seconds={roamingSeconds} discrete={galleryModeHasFocus(preferences.mode)}
            onSpeedChange={seconds => setPreferences(p => ({...p, roamingSpeeds: {...p.roamingSpeeds, [p.mode]: seconds}}))}/>
        </div> : null}
      </div>
      {reducedMotion && roaming ? <span className="gallery-waterfall-note" role="status">减少动态效果已开启，漫游暂时暂停</span> : null}
    </div>
    {records.length ? <GalleryStage records={records} mode={preferences.mode} currentId={currentId}
      density={preferences.density} showTitles={preferences.showTitles} onPick={pick} onFocus={focus}
      roaming={roaming} roamingSpeed={roamingSeconds}
      onArtist={(artist, recordId) => {
        pick(recordId); openArtistDrawer(app, artist);
      }}/>
      : <div className="empty gallery-empty"><div className="empty-symbol">◫</div>
        <h3>{query.trim() ? '没有找到匹配的收藏' : '还没有可展示的收藏'}</h3>
        <p>{query.trim() ? '换个关键词，或看看全部收藏。' : '收藏中的封面、照片与感想会出现在这里。'}</p>
        {query.trim() ? <button type="button" onClick={() => setQuery('')}>清除搜索</button>
          : <a className="link-button" href="#domestic">前往收藏</a>}
      </div>}
  </div>;
}
