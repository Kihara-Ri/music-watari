// 添加 / 编辑专辑表单：封面自动抓取（唯一精确匹配自动带入）、日元成本实时折算、
// 库内模糊匹配带入（含重复提示与艺人纠错；输入比库内标题长时不覆盖，只建议）、
// 实物照片（HEIC 压缩）、碟盒/版次/侧标联动。
import {useEffect, useRef, useState} from 'react';
import {api} from '../core/api';
import {today, yuan, fmtJPY} from '../core/format';
import {prefs} from '../core/prefs';
import {matchRecords, norm, artistSuggestions} from '../core/search';
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import type {AlbumRecord, Currency, Status} from '../types';
import {STATUS_NAMES} from '../types';
import {Seg} from '../components/ui/Seg';
import {Switch} from '../components/ui/Switch';
import {ShopField} from '../components/ShopField';
import {CamIco} from '../components/icons';
import {Field, TextareaField} from './fields';
import {usePhotoSlots, PhotoThumbs} from './PhotoSlots';
import {useFormSubmit} from './shared';

interface CoverCandidate {
  token: string; title: string; artist: string; year?: string;
  thumbnail: string; exact: boolean;
}

const VERSION_PRESETS = ['Jewel Case', '纸盒', 'Digipak'];

export function openRecordForm(app: AppCtx, id?: string) {
  app.openDrawer({title: id ? '编辑专辑' : '添加专辑', asForm: true, content: <RecordForm id={id}/>});
}

export function RecordForm({id}: {id?: string}) {
  const app = useApp();
  const r = id ? app.rec(id) : undefined;
  const {error, saving, run, setError} = useFormSubmit();
  const formRef = useRef<HTMLFormElement>(null);

  const base = useRef<Partial<AlbumRecord>>(r ? {...r} : {
    title: '', artist: '', price: '', date: today(),
    currency: (prefs.get('currency', 'JPY') as Currency) || 'JPY',
    location: prefs.get('location', ''), fees: '0', actual: '', note: '',
  });
  const where: Status | null = r ? null : (base.current.currency === 'CNY' ? 'domestic' : 'overseas');

  const [v, setV] = useState(() => ({
    title: base.current.title || '',
    artist: base.current.artist || '',
    price: base.current.currency === 'JPY' && base.current.price !== ''
      ? String(Math.round(Number(base.current.price))) : (base.current.price || ''),
    date: base.current.date || today(),
    currency: (base.current.currency || 'JPY') as Currency,
    location: base.current.location || '',
    fees: base.current.fees || '0',
    version: base.current.version || '',
    pressing: base.current.pressing || '',
    obi: base.current.obi || '',
    note: base.current.note || '',
    noteAlbum: base.current.noteAlbum || '',
    status: (where ?? base.current.status) as Status | undefined,
  }));
  const set = (patch: Partial<typeof v>) => setV(prev => ({...prev, ...patch}));
  const dirty = () => app.setDrawerDirty(true);

  // ── 封面 ──
  const [coverStatus, setCoverStatus] = useState(r?.cover ? '已自动匹配' : '填写后自动抓取');
  const [candidates, setCandidates] = useState<CoverCandidate[]>([]);
  const [hasCover, setHasCover] = useState(!!r?.cover);
  const lastQuery = useRef<string | null>(null);
  const coverTimer = useRef<number | undefined>(undefined);

  const coverKey = () => `${v.title.trim()}\n${v.artist.trim()}`;
  const stillCurrent = (key: string) => formRef.current?.isConnected && coverKey() === key;

  async function chooseCover(token: string, key: string) {
    setCoverStatus('正在抓取封面…');
    try {
      const result = await api<{cover: string; coverSource: {title: string; artist: string}}>(
        'covers/download', {token});
      if (!stillCurrent(key)) return;
      base.current = {...base.current, cover: result.cover, coverSource: result.coverSource};
      setHasCover(true);
      setCoverStatus(`已匹配：${result.coverSource.title} · ${result.coverSource.artist}`);
      setCandidates([]);
      dirty();
    } catch (err) {
      if (stillCurrent(key)) setCoverStatus(err instanceof Error ? err.message : String(err));
    }
  }

  async function findCover(automatic: boolean) {
    const key = coverKey();
    const title = v.title.trim(), artist = v.artist.trim();
    if (!title || !artist) {
      if (!automatic) setCoverStatus('请先填写专辑名和艺人。');
      return;
    }
    if (automatic && (hasCover || lastQuery.current === key)) return;
    lastQuery.current = key;
    setCoverStatus('正在查找封面…');
    setCandidates([]);
    try {
      const result = await api<{candidates: CoverCandidate[]; warnings?: string[]}>(
        'covers/search', {title, artist, country: 'AUTO'});
      if (!stillCurrent(key)) return;
      const cs = result.candidates;
      const exact = cs.filter(c => c.exact);
      if (automatic && !hasCover && exact.length === 1) {
        await chooseCover(exact[0].token, key);
        return;
      }
      let status = cs.length ? '找到多个候选，点击选择：' : '未找到，调整名称后可重试';
      if (result.warnings?.length) status += ' 部分资料库暂不可用。';
      setCoverStatus(status);
      setCandidates(cs);
    } catch (err) {
      if (stillCurrent(key)) setCoverStatus(err instanceof Error ? err.message : String(err));
    }
  }

  const scheduleCover = () => {
    clearTimeout(coverTimer.current);
    coverTimer.current = window.setTimeout(() => findCover(true), 450);
  };
  useEffect(() => () => { clearTimeout(coverTimer.current); }, []);

  // ── 库内匹配 / 重复提示 / 艺人纠错 ──
  const [hints, setHints] = useState<{label: string; items: {id: string; text: string}[]}>({label: '', items: []});
  const [dupHint, setDupHint] = useState('');
  const artistAuto = useRef(false);
  const hintTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => { clearTimeout(hintTimer.current); }, []);

  function applyMatch(m: AlbumRecord) {
    let artist = v.artist;
    if (!artist || artistAuto.current || norm(artist) !== norm(m.artist)) {
      artist = m.artist;
      artistAuto.current = true;
    }
    set({title: m.title, artist});
    if (m.cover) { base.current = {...base.current, cover: m.cover}; setHasCover(true); }
    setCoverStatus(m.cover ? '已带入库内封面' : '填写后自动抓取');
    setHints({label: '已带入库内资料，可继续修改。', items: []});
    dirty();
  }

  const onTitleInput = (value: string) => {
    if (norm(value) !== norm(base.current.title || '')) artistAuto.current = false;
    set({title: value});
    dirty();
    lastQuery.current = null;
    setCoverStatus(hasCover ? '已有封面' : '填写后自动抓取');
    clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => {
      const q = value.trim();
      const dup = app.state.records.filter(x => q && norm(x.title) === norm(q) && x.id !== base.current.id);
      setDupHint(dup.length
        ? `库中已有 ${dup.length} 张这张专辑（${dup.map(x => STATUS_NAMES[x.status] || x.status).join('、')}）。同一张买了多个版本就分别保存，保存后可在版本里注明区别。`
        : '');
      if (q.length < 2) { setHints({label: '', items: []}); return; }
      const hits = matchRecords(q, app.state.records);
      if (!hits.length) { setHints({label: '', items: []}); return; }
      // 输入比库内标题更长＝在刻意添加内容（续作编号、版本注记等），不自动覆盖标题，
      // 只给点击建议；打错字 / 打到一半 / 全名命中仍自动带入
      const adding = norm(q).length > norm(hits[0].r.title).length;
      if (!adding && (hits.length === 1 || hits[0].sc - hits[1].sc >= 0.12)) {
        applyMatch(hits[0].r);
      } else {
        setHints({label: '找到相似专辑，点击带入：', items: hits.map(h => ({id: h.r.id, text: `${h.r.title} — ${h.r.artist}`}))});
      }
    }, 300);
  };

  const onArtistInput = (value: string) => {
    artistAuto.current = false;
    set({artist: value});
    dirty();
    clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => {
      const q = norm(value.trim());
      if (q.length < 1) { setHints({label: '', items: []}); return; }
      const hits = artistSuggestions(q, app.state.records);
      const exactExists = app.state.records.some(x => norm(x.artist) === q);
      setHints({
        label: exactExists ? '' : '没有完全匹配的艺人，你是想输入：',
        items: hits.map(a => ({id: 'artist:' + a, text: a})),
      });
    }, 300);
  };

  const applyHint = (hid: string) => {
    if (hid.startsWith('artist:')) {
      set({artist: hid.slice(7)});
      setHints({label: '已更正艺人名。', items: []});
      dirty();
      return;
    }
    const m = app.rec(hid);
    if (m) applyMatch(m);
  };

  // ── 成本折算预览（按日期缓存当日汇率） ──
  const rateCache = useRef<{date: string; rate: number | null} | null>(null);
  const [preview, setPreview] = useState<{hidden: boolean; text: string}>({hidden: true, text: ''});

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (v.currency === 'CNY') { if (!cancelled) setPreview({hidden: true, text: ''}); return; }
      let rate: number | null = null;
      if (v.price !== '') {
        if (rateCache.current?.date === v.date) {
          rate = rateCache.current.rate;
        } else {
          try {
            const res = await api<{rate: number | null}>('rate?date=' + (v.date || today()));
            rate = res.rate;
          } catch { rate = null; }
          rateCache.current = {date: v.date, rate};
        }
      }
      if (cancelled) return;
      const fees = Number(v.fees || 0);
      const cost = rate ? Number(v.price) * Number(rate) / 100 + fees : null;
      let text = `折合成本 ${v.price === '' ? '—' : cost === null ? '待定' : yuan(Number(cost.toFixed(2)))}`;
      if (v.price !== '' && cost === null) text += ' · 暂无当日汇率';
      if (rate) text += ` · 100 円 = ¥${Number(rate).toFixed(2)}`;
      setPreview({hidden: false, text});
    })();
    return () => { cancelled = true; };
  }, [v.currency, v.price, v.date, v.fees]);

  // ── 照片 ──
  const photos = usePhotoSlots(
    r ? Array.from({length: r.photoCount || 0}, (_, i) => ({existing: i})) : [],
    app.toast);
  const fileInput = useRef<HTMLInputElement>(null);

  // 该副本若在日元运单里分摊过运费，费用字段下注明日元原额与折算
  const shipItem = (() => {
    const s = r?.shipmentId ? app.state.shipments.find(x => x.id === r.shipmentId) : undefined;
    return s && s.currency === 'JPY' ? s.items.find(i => i.recordId === id) : undefined;
  })();

  // 是否有实际改动：与打开表单时的快照逐字比对，改回原值会自动回到「未修改」态。
  // 照片槽只记序号/长度（data URL 太长），失败槽与保存口径一致地忽略。
  const sign = () => JSON.stringify([v, base.current.cover || '',
    photos.slots.map(p => 'existing' in p ? `e${p.existing}` : 'pending' in p ? 'p' : 'error' in p ? '' : `d${p.data.length}`)]);
  const pristine = useRef(sign());
  const edited = sign() !== pristine.current;
  useEffect(() => { app.setDrawerDirty(edited); }, [edited]);

  // ── 碟盒自定义输入 ──
  const [customVersion, setCustomVersion] = useState(
    !!v.version && !VERSION_PRESETS.includes(v.version));
  const isCustomSeg = !!v.version && !VERSION_PRESETS.includes(v.version);

  const pressingOptions = (() => {
    const os = [{value: '', label: '未设置'}, {value: '日版', label: '日版'}, {value: '外版', label: '外版'}];
    if (v.pressing && !os.some(o => o.value === v.pressing)) os.push({value: v.pressing, label: v.pressing});
    return os;
  })();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const names: [string, string][] = [['title', '专辑名'], ['artist', '艺人'], ['price', '金额'], ['date', '买入日期']];
    const miss = names.filter(([k]) => !String((v as Record<string, unknown>)[k] ?? '').trim());
    if (miss.length) { setError('请填写：' + miss.map(([, n]) => n).join('、')); return; }
    if (photos.hasPending) { setError('还有照片在处理中，等缩略图就绪后再保存'); return; }
    run(app, async () => {
      const payload: Record<string, unknown> = {...base.current, ...v, status: v.status || where || base.current.status};
      delete payload.cost;
      delete payload.rate;
      payload.actual = '';
      payload.photos = photos.slots.filter(p => !('error' in p))
        .map(p => 'existing' in p ? p.existing : (p as {data: string}).data);
      prefs.set('location', v.location);
      prefs.set('currency', v.currency);
      await api('records', payload);
    });
  };

  return (
    <form id="record-form" ref={formRef} onSubmit={submit} noValidate
          data-status={where || r?.status} data-cur={v.currency}>
      <div className="drawer-body">
        <div className="error" role="alert">{error}</div>
        <div className="form-grid">
          <Field label="专辑名" name="title" required autoComplete="off" value={v.title}
                 onChange={e => onTitleInput(e.target.value)} onBlur={scheduleCover}/>
          <Field label="艺人" name="artist" required autoComplete="off" value={v.artist}
                 onChange={e => onArtistInput(e.target.value)} onBlur={scheduleCover}/>
        </div>
        <div id="ta-hints" className="suggestions">
          {hints.label ? <small>{hints.label}</small> : null}
          {hints.items.map(h => (
            <button key={h.id} type="button" className="quiet"
                    onClick={() => applyHint(h.id)}>{h.text}</button>
          ))}
        </div>
        {dupHint ? <p className="dup-hint">{dupHint}</p> : null}

        <section className="cover-search">
          <div className="cover-search-head">
            <strong>封面</strong>
            <span className="cover-status" role="status">{coverStatus}</span>
            <button type="button" onClick={() => findCover(false)}>重新查找</button>
          </div>
          <div className="cover-candidates">
            {candidates.map(c => (
              <button key={c.token} type="button" className="cover-choice"
                      onClick={() => chooseCover(c.token, coverKey())}>
                <img src={c.thumbnail} alt=""/>
                <span>{c.title}</span>
                <small>{c.artist} · {c.year}</small>
              </button>
            ))}
          </div>
        </section>

        <section className="money-block form-section">
          <div className="money-row">
            <div className="field">
              <label htmlFor="f-price">买入金额</label>
              <div className="amount-group">
                <Seg className="seg-cur" ariaLabel="币种"
                     options={[{value: 'JPY', label: '日元'}, {value: 'CNY', label: '人民币'}]}
                     value={v.currency}
                     onValue={c => set({
                       currency: c as Currency,
                       price: c === 'JPY' && v.price !== '' ? String(Math.round(Number(v.price))) : v.price,
                     })}/>
                <input id="f-price" name="price" type="number" required min="0"
                       step={v.currency === 'JPY' ? '10' : '1'} inputMode="decimal"
                       placeholder="按币种填写" value={v.price}
                       onChange={e => { set({price: e.target.value}); dirty(); }}/>
              </div>
            </div>
            <Field label="买入日期" name="date" type="date" required value={v.date}
                   onChange={e => { set({date: e.target.value}); dirty(); }}/>
          </div>
          {!preview.hidden && <div className="cost-line">{preview.text}</div>}
        </section>

        <div className="form-grid form-section">
          <ShopField value={v.location} records={app.state.records}
                     defaultShop={prefs.get('location', '')}
                     onChange={val => { set({location: val}); dirty(); }}/>
          {!id && (
            <div className="field">
              <span className="field-label"><label>入库位置</label></span>
              <Seg ariaLabel="入库位置"
                   options={[{value: 'overseas', label: '◧ 海外库存'}, {value: 'domestic', label: '▤ 国内库存'}]}
                   value={v.status || ''} onValue={s => { set({status: s as Status}); dirty(); }}/>
            </div>
          )}
        </div>

        <div className="form-section form-grid">
          <div className="field full">
            <label>碟盒（选填）</label>
            <Seg ariaLabel="碟盒"
                 options={[
                   {value: '__none', label: '未设置'},
                   ...VERSION_PRESETS.map(p => ({value: p, label: p})),
                   {value: '__custom', label: '自定义…'},
                 ]}
                 value={isCustomSeg ? '__custom' : (v.version || '__none')}
                 onValue={val => {
                   dirty();
                   if (val === '__custom') { setCustomVersion(true); return; }
                   setCustomVersion(false);
                   set({version: val === '__none' ? '' : val});
                 }}/>
            <input id="f-version" name="version" value={v.version}
                   placeholder="填写其他碟盒类型，如 初回限定" autoComplete="off"
                   hidden={!customVersion}
                   onChange={e => { set({version: e.target.value}); dirty(); }}/>
          </div>
          <div className="field">
            <span className="field-label"><label>版次（选填）</label></span>
            <Seg ariaLabel="版次" options={pressingOptions} value={v.pressing}
                 onValue={p => {
                   dirty();
                   if (p !== '日版') set({pressing: p, obi: ''});
                   else set({pressing: p});
                 }}/>
          </div>
          <div className="field switch-field" hidden={v.pressing !== '日版'}>
            <div className="switch-line">
              <Switch on={v.obi === '带侧标'} onToggle={() => {
                dirty();
                set({obi: v.obi === '带侧标' ? '无侧标' : '带侧标'});
              }}/>
              <label className="switch-text">{v.obi === '带侧标' ? '带侧标（帯在）' : '无侧标（帯缺失）'}</label>
            </div>
          </div>
        </div>

        <div className="form-section">
          <div className="field">
            <label>实物照片（选填 · 最多 9 张，支持 iPhone 的 HEIC）</label>
            <PhotoThumbs slots={photos.slots} recordId={r?.id ?? null} onRemove={i => { photos.remove(i); dirty(); }}/>
            <div className="photo-actions">
              <button type="button" onClick={() => fileInput.current?.click()}>
                {CamIco}<span>添加实物照片</span>
              </button>
            </div>
            <input ref={fileInput} type="file" accept="image/*,.heic,.heif" multiple hidden
                   onChange={e => {
                     const files = [...(e.target.files ?? [])];
                     e.target.value = '';
                     photos.addFiles(files);
                     if (files.length) dirty();
                   }}/>
          </div>
        </div>

        <details className="adv">
          <summary>更多信息</summary>
          <div className="form-grid">
            <div className="field">
              <label htmlFor="f-fees">额外买入费用（人民币）</label>
              <div className="amount-group">
                <span className="cur-static">人民币</span>
                <input id="f-fees" name="fees" type="number" min="0" step="0.01"
                       inputMode="decimal" value={v.fees}
                       onChange={e => { set({fees: e.target.value}); dirty(); }}/>
              </div>
              {shipItem?.feeOriginal
                ? <small>国际运费 {fmtJPY(shipItem.feeOriginal)} 円 ≈ {yuan(shipItem.fee)}，已摊入上列费用</small>
                : null}
            </div>
            <TextareaField label="笔记 · 这张副本" name="note" value={v.note}
                           onChange={val => { set({note: val}); dirty(); }}/>
            <TextareaField label="笔记 · 这张专辑（感想与音乐记录，所有副本共享）" name="noteAlbum"
                           value={v.noteAlbum} onChange={val => { set({noteAlbum: val}); dirty(); }}/>
          </div>
        </details>
      </div>
      <div className="drawer-footer">
        <button type="button" onClick={() => app.closeDrawer()}>取消</button>
        <button type="submit" className="primary" disabled={saving || !edited}>{id ? '保存修改' : '保存并入库'}</button>
      </div>
    </form>
  );
}
