// 艺人资料抽屉：打开入口、解析/资料/目录三路状态、副本详情往返与封面加载闸门。
// 本模块持有全部局部状态；ArtistProfile 只负责展示。
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import {
  artistsApi, dedupeWorks, isAbort, statusOf, errorMessage,
} from '../core/artists';
import type {
  ArtistCandidate, ArtistWork, CatalogCategory, CollectionRecord, ProfileResponse,
  ResolveResult, SourceState, WorkLinkInfo,
} from '../core/artists';
import {ArtistProfile} from '../components/ArtistProfile';
import type {ArtworkGate} from '../components/ArtistProfile';
import {openDetail} from './DetailDrawer';

const EMPTY_SOURCE: SourceState = {fetchedAt: null, cache: 'missing', refreshSuggested: false, error: null};

export interface ArtistDrawerRestore {
  category?: CatalogCategory;
  scrollTop?: number;
}

export function openArtistDrawer(app: AppCtx, artist: string, restore?: ArtistDrawerRestore) {
  app.openDrawer({
    title: artist,
    wide: true,
    // key：按艺人强制重挂载，杜绝任何复用路径下上一位的资料/目录状态残留
    content: <ArtistDrawerBody key={artist} artist={artist} restore={restore}/>,
  });
}

type Resolution =
  | {phase: 'loading'}
  | {phase: 'candidates' | 'not_found' | 'unavailable'; data?: ResolveResult; error?: string};

function ArtistDrawerBody({artist, restore}: {artist: string; restore?: ArtistDrawerRestore}) {
  const app = useApp();
  const abortRef = useRef<AbortController | null>(null);
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [works, setWorks] = useState<ArtistWork[]>([]);
  const [complete, setComplete] = useState(false);
  const [progress, setProgress] = useState<{loaded: number; total: number | null; refreshing: boolean} | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [category, setCategory] = useState<CatalogCategory>(restore?.category ?? 'album');
  const [workLinks, setWorkLinks] = useState<Record<string, WorkLinkInfo>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const roundRef = useRef<string | null>(null);
  const offsetRef = useRef(0);
  const hasWorksRef = useRef(false);
  const restoredRef = useRef(false);
  const savedViewRef = useRef<ArtistDrawerRestore>({category: restore?.category, scrollTop: restore?.scrollTop});
  const bodyRef = useRef<HTMLDivElement>(null);
  // 封面加载闸门：进入可见区才请求，同时最多 2 个（组件内状态，不用模块级全局）
  const gate = useMemo<ArtworkGate>(() => {
    const q: {active: number; waiters: (() => void)[]} = {active: 0, waiters: []};
    const pump = () => { while (q.active < 2 && q.waiters.length) { q.active += 1; q.waiters.shift()!(); } };
    return {
      acquire(run) { q.waiters.push(run); pump(); },
      release() { q.active = Math.max(0, q.active - 1); pump(); },
    };
  }, []);

  const signal = useCallback(() => {
    abortRef.current?.abort();
    const ctl = new AbortController();
    abortRef.current = ctl;
    return ctl.signal;
  }, []);
  useEffect(() => () => abortRef.current?.abort(), []);

  // 本地收藏：直接由账本状态计算，抽屉打开立即可见，不等外网。
  const collection = useMemo(() => {
    const counts = {holding: 0, shipping: 0, sold: 0};
    const records: CollectionRecord[] = [];
    for (const r of app.state.records) {
      if (r.artist !== artist || r.status === 'trash') continue;
      if (['domestic', 'overseas', 'transit'].includes(r.status)) counts.holding += 1;
      else if (r.status === 'shipping') counts.shipping += 1;
      else if (r.status === 'sold') counts.sold += 1;
      records.push({id: r.id, title: r.title, status: r.status, cover: r.cover,
                    version: r.version, pressing: r.pressing, obi: r.obi});
    }
    return {counts, records};
  }, [app.state.records, artist]);

  // 目录：一次页请求对应一个来源请求；只有 complete 才整表替换，刷新轮次保留旧列表。
  const runCatalog = useCallback(async (refresh: boolean, startOffset = 0, keepOld = false) => {
    const safe = signal();
    setPageError(null);
    setProgress({loaded: 0, total: null, refreshing: refresh && keepOld});
    let offset = startOffset;
    let loaded = 0;
    let restarted = false;
    for (;;) {
      try {
        offsetRef.current = offset;
        const page = await artistsApi.catalog(artist, {offset, refresh, roundId: roundRef.current, signal: safe});
        roundRef.current = page.roundId ?? roundRef.current;
        if (page.complete) {
          setWorks(dedupeWorks(page.works));
          setComplete(true);
          setProgress(null);
          setPageError(null);
          break;
        }
        loaded += page.returned;
        setProgress({loaded, total: page.total, refreshing: refresh && keepOld});
        // 无旧列表时边读边展示；有旧完整目录时只推进度，待本轮完整后一次替换
        if (!keepOld || !hasWorksRef.current) {
          setWorks(prev => {
            const map = new Map(prev.map(w => [w.mbid, w]));
            for (const w of page.works) if (!map.has(w.mbid)) map.set(w.mbid, w);
            return dedupeWorks([...map.values()]);
          });
        }
        if (page.roundError || page.nextOffset === null) {
          if (page.roundError) setPageError(page.roundError);
          setProgress(null);
          break;
        }
        offset = page.nextOffset;
      } catch (err) {
        if (isAbort(err)) return;
        if (statusOf(err) === 409 && !restarted) {
          restarted = true;  // 轮次过期：自动重开一轮
          roundRef.current = null;
          offset = 0;
          loaded = 0;
          continue;
        }
        setPageError(errorMessage(err));
        setProgress(null);
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist, signal]);

  // loadProfile ↔ runResolve 相互触发：经 ref 打破声明环，渲染后指向最新实现。
  const runResolveRef = useRef<(force: boolean, searchName?: string) => Promise<void>>(async () => {});

  const loadProfile = useCallback(async (refresh = false): Promise<ProfileResponse | null> => {
    setProfileLoading(true); setProfileError(null);
    try {
      const data = await artistsApi.profile(artist, {refresh, signal: signal()});
      setProfile(data);
      setWorkLinks(data.workLinks);
      setProfileLoading(false);
      if (data.status === 'needs_resolution') {
        setResolution({phase: 'loading'});
        void runResolveRef.current(false);
        return data;
      }
      setResolution(null);
      return data;
    } catch (err) {
      if (isAbort(err)) return null;
      setProfileLoading(false);
      setProfileError(errorMessage(err));
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist, signal]);

  const runResolve = useCallback(async (force: boolean, searchName?: string): Promise<void> => {
    setBusy('resolve');
    setResolution({phase: 'loading'});
    try {
      const data = await artistsApi.resolve(artist, {force, searchName, signal: signal()});
      if (data.status === 'resolved') {
        setResolution(null);
        setBusy(null);
        const bound = await loadProfile(true);
        if (bound?.status === 'bound') await runCatalog(true);
        return;
      }
      if (data.status === 'not_found') setResolution({phase: 'not_found', data});
      else if (data.status === 'unavailable') setResolution({phase: 'unavailable', error: data.error});
      else setResolution({phase: 'candidates', data});
    } catch (err) {
      if (isAbort(err)) return;
      setResolution({phase: 'unavailable', error: errorMessage(err)});
    }
    setBusy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist, signal, loadProfile, runCatalog]);
  runResolveRef.current = runResolve;


  // 首次进入：资料（含解析）→ 目录
  useEffect(() => {
    void (async () => {
      const data = await loadProfile(false);
      if (data && data.status === 'bound') await runCatalog(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { hasWorksRef.current = works.length > 0; }, [works]);

  // 返回艺人资料时恢复分类与列表位置
  useEffect(() => {
    if (restoredRef.current || !restore?.scrollTop) return;
    const body = bodyRef.current?.closest('.drawer-body') as HTMLElement | null;
    if (body && body.scrollHeight > body.scrollTop) {
      body.scrollTop = restore.scrollTop;
      restoredRef.current = true;
    }
  });

  const sourceState: SourceState = profile?.sourceState ?? EMPTY_SOURCE;

  const openCopy = (id: string) => {
    const body = bodyRef.current?.closest('.drawer-body') as HTMLElement | null;
    savedViewRef.current = {category, scrollTop: body?.scrollTop ?? 0};
    openDetail(app, id, {label: '返回艺人资料', run: () => openArtistDrawer(app, artist, savedViewRef.current)});
  };

  const doLink = async (record: CollectionRecord, work: ArtistWork) => {
    setBusy(record.id);
    try {
      const current = workLinks[record.id];
      const data = await artistsApi.workLink({
        artist, recordId: record.id, releaseGroupMbid: work.mbid,
        expectedReleaseGroupMbid: current ? current.releaseGroupMbid : null,
        recordArtist: artist, recordTitle: record.title,
      });
      setWorkLinks(prev => ({...prev, [record.id]:
        {releaseGroupMbid: data.link.releaseGroupMbid, artistMbid: data.link.artistMbid, state: 'confirmed'}}));
      app.toast(`已关联《${record.title}》`);
    } catch (err) {
      if (isAbort(err)) return;
      app.toast(errorMessage(err), statusOf(err) === 409 ? 'warn' : 'err');
      if (statusOf(err) === 409) void loadProfile(false);
    }
    setBusy(null);
  };

  const doUnlink = async (record: CollectionRecord) => {
    const current = workLinks[record.id];
    if (!current) return;
    setBusy(record.id);
    try {
      await artistsApi.workUnlink(record.id, current.releaseGroupMbid);
      setWorkLinks(prev => {
        const next = {...prev};
        delete next[record.id];
        return next;
      });
      app.toast('已取消关联');
    } catch (err) {
      if (isAbort(err)) return;
      app.toast(errorMessage(err), statusOf(err) === 409 ? 'warn' : 'err');
      if (statusOf(err) === 409) void loadProfile(false);
    }
    setBusy(null);
  };

  const pickCandidate = async (candidate: ArtistCandidate) => {
    setBusy('bind');
    try {
      await artistsApi.bind(artist, candidate.mbid,
                            profile?.identities?.artistMbid ?? null, signal());
      app.toast(`已确认艺人：${candidate.name}`);
      setResolution(null);
      setBusy(null);
      roundRef.current = null;
      const data = await loadProfile(true);
      if (data?.status === 'bound') await runCatalog(true);
    } catch (err) {
      if (isAbort(err)) return;
      app.toast(errorMessage(err), 'err');
      setBusy(null);
    }
  };

  const refreshAll = async () => {
    setBusy('refresh');
    roundRef.current = null;
    await loadProfile(true);
    await runCatalog(true, 0, true);
    setBusy(null);
  };

  const changeArtist = async () => {
    roundRef.current = null;
    setWorks([]);
    setComplete(false);
    hasWorksRef.current = false;
    await runResolve(true);
  };

  const retryPage = () => {
    if (pageError?.includes('重新开始')) {
      roundRef.current = null;  // 来源数量变化等：重开一轮刷新
      void runCatalog(true, 0, hasWorksRef.current);
    } else {
      void runCatalog(roundRef.current === null, offsetRef.current, hasWorksRef.current);
    }
  };

  return (
    <div ref={bodyRef}>
      <ArtistProfile
        artist={artist}
        modules={app.modules}
        profile={profile?.profile ?? null}
        identities={profile?.identities ?? null}
        identityInvalid={profile?.identityError === 'invalid'}
        sourceState={sourceState}
        profileLoading={profileLoading}
        profileError={profileError}
        resolution={resolution}
        collection={collection}
        works={works}
        catalogComplete={complete}
        progress={progress}
        pageError={pageError}
        category={category}
        workLinks={workLinks}
        expanded={expanded}
        linking={linking}
        gate={gate}
        busy={busy}
        onCategory={setCategory}
        onToggleWork={mbid => {
          setExpanded(cur => (cur === mbid ? null : mbid));
          setLinking(false);
        }}
        onToggleLinker={() => setLinking(v => !v)}
        onOpenRecord={openCopy}
        onLink={doLink}
        onUnlink={doUnlink}
        onRetryPage={retryPage}
        onRefresh={() => void refreshAll()}
        onChangeArtist={() => void changeArtist()}
        onRetryProfile={() => {
          if (resolution) void runResolve(resolution.phase === 'candidates');
          else void loadProfile(true).then(data => { if (data?.status === 'bound') return runCatalog(true); });
        }}
        onPickCandidate={c => void pickCandidate(c)}
        onSearchName={name => void runResolve(!!profile?.identities, name)}
      />
    </div>
  );
}
