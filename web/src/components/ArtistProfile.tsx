// 艺人资料面板（纯展示）：结构化概况、我的收藏、分类目录、候选确认与副本关联。
// 只接收 props 与回调，不做请求；打开、状态与详情往返由 forms/ArtistDrawer 负责。
import {useEffect, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {
  CATEGORY_LABELS, CATEGORY_ORDER, artistTypeText, lifeSpanText, workTypeText, strictTitle,
} from '../core/artists';
import type {
  ArtistCandidate, ArtistWork, CatalogCategory, CollectionRecord, IdentityInfo,
  ProfileResponse, ResolveResult, SourceState, WorkLinkInfo,
} from '../core/artists';
import {statusName} from '../core/modules';
import type {ModuleFlags} from '../types';

export interface WorkLinkRow {
  record: CollectionRecord;
  link: WorkLinkInfo;
}

export interface SuggestionRow {
  work: ArtistWork;
  records: CollectionRecord[];
}

export interface ArtistProfileProps {
  artist: string;
  modules: ModuleFlags;
  profile: ProfileResponse['profile'];
  identities: IdentityInfo | null;
  identityInvalid: boolean;
  sourceState: SourceState;
  profileLoading: boolean;
  profileError: string | null;
  resolution: {phase: 'loading' | 'candidates' | 'not_found' | 'unavailable'; data?: ResolveResult; error?: string} | null;
  collection: {counts: {holding: number; shipping: number; sold: number}; records: CollectionRecord[]};
  works: ArtistWork[];
  catalogComplete: boolean;
  progress: {loaded: number; total: number | null; refreshing: boolean} | null;
  pageError: string | null;
  category: CatalogCategory;
  workLinks: Record<string, WorkLinkInfo>;
  expanded: string | null;
  linking: boolean;
  onCategory(v: CatalogCategory): void;
  onToggleWork(mbid: string): void;
  onToggleLinker(): void;
  onOpenRecord(id: string): void;
  onLink(record: CollectionRecord, work: ArtistWork): void;
  onUnlink(record: CollectionRecord): void;
  onRetryPage(): void;
  onRefresh(): void;
  onChangeArtist(): void;
  onRetryProfile(): void;
  onPickCandidate(candidate: ArtistCandidate): void;
  onSearchName(name: string): void;
  busy: string | null;
  gate: ArtworkGate;
}

// ── 封面：优先已确认关联的本地副本封面，否则按需加载碟渡 artwork API ──
export interface ArtworkGate {
  acquire(run: () => void): void;
  release(): void;
}

function WorkCover({work, localCover, gate}: {
  work: ArtistWork; localCover: string | null; gate: ArtworkGate;
}) {
  const [visible, setVisible] = useState(false);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, {rootMargin: '120px'});
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const remote = localCover ? null : `/api/artists/artwork/${work.mbid}`;
  useEffect(() => {
    if (!visible || src || failed || !remote) return;
    let cancelled = false;
    gate.acquire(() => {
      if (cancelled) { gate.release(); return; }
      setSrc(remote);
    });
    return () => { cancelled = true; };
  }, [visible, src, failed, remote, gate]);

  const release = () => gate.release();
  if (localCover || src) {
    return (
      <span className="work-cover" ref={ref}>
        <img src={localCover ?? src!} alt="" loading="lazy"
             onError={() => { if (!localCover) { release(); setSrc(null); setFailed(true); } }}
             onLoad={() => { if (!localCover) release(); }}/>
      </span>
    );
  }
  if (failed) {
    return <span className="work-cover cover-fallback" ref={ref} role="img" aria-label={`${work.title}，暂无封面`}>
      <span>{work.title.slice(0, 1)}</span>
    </span>;
  }
  return <span className="work-cover cover-fallback pending" ref={ref} aria-hidden="true"><span>◌</span></span>;
}

function Meta({children}: {children: ReactNode}) {
  return <span className="profile-meta-item">{children}</span>;
}

export function ArtistProfile(props: ArtistProfileProps) {
  const {
    artist, modules, profile, identities, identityInvalid, sourceState, profileLoading, profileError,
    resolution, collection, works, catalogComplete, progress, pageError, category,
    workLinks, expanded, linking, onCategory, onToggleWork, onToggleLinker, onOpenRecord, onLink,
    onUnlink, onRetryPage, onRefresh, onChangeArtist, onRetryProfile, onPickCandidate, onSearchName, busy, gate,
  } = props;
  const [showAllAliases, setShowAllAliases] = useState(false);
  const [candidateId, setCandidateId] = useState<string | null>(null);
  const [searchName, setSearchName] = useState('');
  const [unlinkedOpen, setUnlinkedOpen] = useState(false);

  const linkedByWork = new Map<string, WorkLinkRow[]>();
  for (const r of collection.records) {
    const link = workLinks[r.id];
    if (!link) continue;
    linkedByWork.set(link.releaseGroupMbid, [...linkedByWork.get(link.releaseGroupMbid) ?? [], {record: r, link}]);
  }
  const unlinked = collection.records.filter(r => {
    const link = workLinks[r.id];
    return !link || link.state !== 'confirmed';
  });

  // 标题严格匹配且只命中一个作品 → 「可能已收藏」建议（不自动成为确定关联）
  const titleWorkCount = new Map<string, number>();
  for (const w of works) {
    const k = strictTitle(w.title);
    titleWorkCount.set(k, (titleWorkCount.get(k) ?? 0) + 1);
  }
  const suggestions = new Map<string, SuggestionRow>();
  for (const w of works) {
    const k = strictTitle(w.title);
    if (titleWorkCount.get(k) !== 1) continue;
    const rows = collection.records.filter(r => strictTitle(r.title) === k
      && workLinks[r.id]?.releaseGroupMbid !== w.mbid);
    if (rows.length) suggestions.set(w.mbid, {work: w, records: rows});
  }

  const shown = works.filter(w => w.category === category);
  const lifeSpan = profile ? lifeSpanText(profile.type, profile.lifeSpan) : [];
  const aliasList = profile?.aliases ?? [];
  const shownAliases = showAllAliases ? aliasList : aliasList.slice(0, 3);
  const selected = resolution?.data?.candidates.find(c => c.mbid === candidateId) ?? null;
  const fetchedAt = sourceState.fetchedAt ? sourceState.fetchedAt.replace('T', ' ') : null;

  return (
    <div className="artist-profile">
      {/* 1. 名称与结构化概况 */}
      <section className="profile-head">
        <h3 className="profile-name">{artist}</h3>
        {profile && profile.name && profile.name !== artist
          ? <p className="profile-source-name">资料名称：{profile.name}</p> : null}
        {identityInvalid ? (
          <p className="profile-banner warn" role="alert">资料身份需重新确认，请更换艺人。</p>
        ) : null}
        {profileLoading && !profile ? <p className="profile-note">正在查找艺人资料…</p> : null}
        {profileError && !profile ? (
          <p className="profile-banner err" role="alert">
            {profileError} <button type="button" className="quiet" onClick={onRetryProfile}>重试</button>
          </p>
        ) : null}
        {profile ? (
          <div className="profile-facts">
            {artistTypeText(profile.type) ? <Meta>{artistTypeText(profile.type)}</Meta> : null}
            {profile.area ? <Meta>关联地区 {profile.area}</Meta> : null}
            {lifeSpan.map(([label, value]) => <Meta key={label}>{label} {value}</Meta>)}
            {profile.disambiguation ? <Meta>{profile.disambiguation}</Meta> : null}
          </div>
        ) : profileLoading || profileError ? null : (
          <p className="profile-note">该艺人的详细资料暂未收录。</p>
        )}
        {profile && aliasList.length ? (
          <p className="profile-aliases">
            <span className="profile-meta-item">别名</span>
            {' '}{shownAliases.join('、')}
            {aliasList.length > 3
              ? <button type="button" className="quiet alias-toggle" onClick={() => setShowAllAliases(v => !v)}>
                  {showAllAliases ? '收起' : `展开全部 ${aliasList.length} 个`}
                </button> : null}
          </p>
        ) : null}
        {profile && profile.genres.length ? (
          <p className="profile-genres">
            <span className="profile-meta-item">音乐类型</span>
            {' '}{profile.genres.join('、')}
          </p>
        ) : null}
        {identities ? (
          <p className="profile-identity small-note">
            {identities.method === 'manual' ? '已人工确认身份' : '已自动核对身份'}
            {profile?.sourceUrl ? <> · <a href={profile.sourceUrl} target="_blank" rel="noopener noreferrer">MusicBrainz 艺人页 ↗</a></> : null}
          </p>
        ) : null}
      </section>

      {/* 2. 我的收藏 */}
      <section className="profile-collection">
        <h4 className="profile-section-title">我的收藏</h4>
        <p className="collection-summary">
          <span>持有 <b>{collection.counts.holding}</b></span>
          <span>售出中 <b>{collection.counts.shipping}</b></span>
          <span>曾收藏 <b>{collection.counts.sold}</b></span>
        </p>
      </section>

      {/* 候选确认 */}
      {resolution ? (
        <section className="profile-resolution">
          {resolution.phase === 'loading'
            ? <p className="profile-note">正在查找艺人资料…</p> : null}
          {resolution.phase === 'candidates' && resolution.data ? (
            <>
              <p className="profile-banner" role="status">有多位同名艺人，请确认。</p>
              {!resolution.data.evidenceComplete
                ? <p className="small-note">候选证据尚未核对完整，请以资料内容为准。</p> : null}
              <ul className="candidate-list">
                {resolution.data.candidates.map(c => (
                  <li key={c.mbid}>
                    <label className={`candidate${candidateId === c.mbid ? ' on' : ''}`}>
                      <input type="radio" name="artist-candidate" value={c.mbid}
                             checked={candidateId === c.mbid}
                             onChange={() => setCandidateId(c.mbid)}/>
                      <span className="candidate-main">
                        <b>{c.name}</b>
                        <small>
                          {[artistTypeText(c.type), c.area, c.disambiguation].filter(Boolean).join(' · ') || '暂无地区与类型资料'}
                          {c.hasEvidence === true ? ' · 与本地专辑标题相符' : ''}
                        </small>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              {selected ? (
                <div className="candidate-confirm">
                  <p>将库内 <b>{artist}</b> 对应到资料库 <b>{selected.name}</b>
                    {selected.disambiguation ? `（${selected.disambiguation}）` : ''}</p>
                  <p className="small-note">确认后，作品目录按这位艺人的身份读取；本地记录名称不变。</p>
                  <button type="button" className="primary" disabled={busy === 'bind'}
                          onClick={() => onPickCandidate(selected)}>确认艺人</button>
                </div>
              ) : null}
              <div className="candidate-search">
                <label className="small-note" htmlFor="artist-search-name">名称不符？调整搜索名称（不写回本地记录）</label>
                <div className="candidate-search-row">
                  <input id="artist-search-name" value={searchName} maxLength={500}
                         placeholder="输入要搜索的名称"
                         onChange={e => setSearchName(e.target.value)}/>
                  <button type="button" disabled={!searchName.trim() || busy === 'resolve'}
                          onClick={() => onSearchName(searchName.trim())}>搜索</button>
                </div>
              </div>
            </>
          ) : null}
          {resolution.phase === 'not_found' ? (
            <div className="profile-empty">
              <p>资料库暂未找到该艺人。</p>
              <p className="small-note">本地收藏不受影响；可调整名称重新搜索。</p>
              <div className="candidate-search-row">
                <input aria-label="调整搜索名称" value={searchName} maxLength={500}
                       placeholder="输入要搜索的名称" onChange={e => setSearchName(e.target.value)}/>
                <button type="button" disabled={!searchName.trim() || busy === 'resolve'}
                        onClick={() => onSearchName(searchName.trim())}>搜索</button>
              </div>
            </div>
          ) : null}
          {resolution.phase === 'unavailable' ? (
            <div className="profile-empty">
              <p role="alert">暂时无法连接资料库。</p>
              <p className="small-note">本地收藏仍可使用。</p>
              <button type="button" onClick={onRetryProfile}>重试</button>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* 3–4. 分类与作品目录 */}
      {identities && !resolution ? (
        <section className="profile-catalog">
          <div className="artist-cats" role="tablist" aria-label="作品分类">
            {CATEGORY_ORDER.map(c => (
              <button key={c} type="button" role="tab" aria-selected={category === c}
                      className={`artist-cat${category === c ? ' on' : ''}`}
                      onClick={() => onCategory(c)}>
                {CATEGORY_LABELS[c]}<b>{works.filter(w => w.category === c).length}</b>
              </button>
            ))}
          </div>
          {progress ? (
            <p className="profile-note" role="status">
              {progress.refreshing ? '正在更新资料…' : '正在读取作品…'}
              已读取 {progress.loaded} / {progress.total ?? '？'} 项作品
            </p>
          ) : null}
          {pageError ? (
            <p className="profile-banner err" role="alert">
              {pageError} <button type="button" className="quiet" onClick={onRetryPage}>重试</button>
            </p>
          ) : null}
          {!progress && !pageError && catalogComplete ? (
            <p className="small-note">资料库收录 {works.length} 项作品。</p>
          ) : null}
          {!progress && !pageError && !catalogComplete && !works.length ? (
            <p className="profile-note">正在读取作品…</p>
          ) : null}
          {shown.length ? (
            <ul className="work-list">
              {shown.map(w => {
                const rows = linkedByWork.get(w.mbid) ?? [];
                const confirmedRows = rows.filter(r => r.link.state === 'confirmed');
                const suggestion = suggestions.get(w.mbid);
                const isOpen = expanded === w.mbid;
                return (
                  <li key={w.mbid} className="artist-work">
                    <button type="button" className="work-row" aria-expanded={isOpen}
                            onClick={() => onToggleWork(w.mbid)}>
                      <WorkCover work={w}
                                 localCover={confirmedRows.find(r => r.record.cover)?.record.cover ?? null}
                                 gate={gate}/>
                      <span className="work-main">
                        <span className="work-title">{w.title}</span>
                        <span className="work-meta">
                          {w.firstReleaseDate ?? '日期未知'}{workTypeText(w) ? ` · ${workTypeText(w)}` : ''}
                        </span>
                      </span>
                      <span className={`work-state${confirmedRows.length ? ' owned' : suggestion ? ' maybe' : ''}`}>
                        {confirmedRows.length ? `已收藏 ${confirmedRows.length} 张`
                          : rows.length ? '关联待核对'
                            : suggestion ? `可能已收藏 · ${suggestion.records.length} 张`
                              : '未关联'}
                      </span>
                    </button>
                    {isOpen ? (
                      <div className="work-detail">
                        {rows.length ? (
                          <ul className="copy-list">
                            {rows.map(({record}) => (
                              <li key={record.id} className="copy-row">
                                <span className="copy-info">
                                  <b>{record.title}</b>
                                  <small>
                                    {statusName(record.status, modules)}
                                    {[record.pressing && (record.pressing === '日版' && record.obi ? `${record.pressing}·${record.obi}` : record.pressing),
                                      record.version].filter(Boolean).join(' · ')}
                                  </small>
                                </span>
                                <span className="copy-actions">
                                  <button type="button" onClick={() => onOpenRecord(record.id)}>详情</button>
                                  <button type="button" className="quiet" disabled={busy === record.id}
                                          onClick={() => onUnlink(record)}>取消关联</button>
                                </span>
                              </li>
                            ))}
                          </ul>
                        ) : <p className="small-note">还没有确认关联的副本。</p>}
                        {suggestion ? (
                          <div className="suggest-box">
                            <p className="small-note">本地有标题相同的副本，可能是这部作品：</p>
                            {suggestion.records.map(r => (
                              <p className="copy-row" key={r.id}>
                                <span className="copy-info"><b>{r.title}</b>
                                  <small>{statusName(r.status, modules)}</small></span>
                                <button type="button" disabled={busy === r.id}
                                        onClick={() => onLink(r, w)}>确认关联</button>
                              </p>
                            ))}
                          </div>
                        ) : null}
                        <div className="linker">
                          <button type="button" className="quiet" aria-expanded={linking}
                                  onClick={onToggleLinker}>
                            {linking ? '收起' : '关联我的副本'}
                          </button>
                          {linking ? (
                            unlinked.length ? (
                              <ul className="copy-list">
                                {unlinked.map(r => (
                                  <li key={r.id} className="copy-row">
                                    <span className="copy-info"><b>{r.title}</b>
                                      <small>{statusName(r.status, modules)}</small></span>
                                    <button type="button" disabled={busy === r.id}
                                            onClick={() => onLink(r, w)}>确认关联</button>
                                  </li>
                                ))}
                              </ul>
                            ) : <p className="small-note">这位艺人名下没有可关联的副本。</p>
                          ) : null}
                        </div>
                        <p className="small-note">
                          <a href={w.sourceUrl} target="_blank" rel="noopener noreferrer">在 MusicBrainz 打开这部作品 ↗</a>
                        </p>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : catalogComplete && !shown.length ? (
            <p className="profile-note">当前分类暂无收录作品。</p>
          ) : null}
        </section>
      ) : null}

      {/* 5. 未关联副本 */}
      {identities && !resolution && unlinked.length ? (
        <section className="profile-unlinked">
          <button type="button" className="quiet" aria-expanded={unlinkedOpen}
                  onClick={() => setUnlinkedOpen(v => !v)}>
            未关联的本地副本 · {unlinked.length} 张 {unlinkedOpen ? '▾' : '▸'}
          </button>
          {unlinkedOpen ? (
            <ul className="copy-list">
              {unlinked.map(r => (
                <li key={r.id} className="copy-row">
                  <span className="copy-info"><b>{r.title}</b>
                    <small>{statusName(r.status, modules)}</small></span>
                  <button type="button" onClick={() => onOpenRecord(r.id)}>详情</button>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {/* 6. 来源与次要操作 */}
      <section className="profile-foot">
        <p className="small-note">
          {fetchedAt ? `资料更新于 ${fetchedAt}` : '资料尚未读取'}
          {sourceState.cache === 'stale' || sourceState.error ? ' · 当前显示缓存资料' : ''}
        </p>
        {sourceState.error && !identityInvalid ? (
          <p className="small-note" role="alert">{sourceState.error}</p>
        ) : null}
        <div className="profile-ops">
          <button type="button" disabled={busy === 'refresh'} onClick={onRefresh}>更新资料</button>
          <button type="button" disabled={busy === 'resolve'} onClick={onChangeArtist}>更换艺人</button>
        </div>
      </section>
    </div>
  );
}
