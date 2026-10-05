// 照片批量工作区：逐张上传、点击切组、移图、并行识别、草稿续接与确认入库。
import {useEffect, useRef, useState} from 'react';
import {api} from '../core/api';
import {today} from '../core/format';
import {compressPhoto, MAX_PHOTOS} from '../core/photos';
import {prefs} from '../core/prefs';
import {listingText, newImportGroup} from '../core/recognition';
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import type {ImportDraft, ImportGroup, RecognitionFields, VisionConfig} from '../types';
import {Seg} from '../components/ui/Seg';
import {Dropdown} from '../components/ui/Dropdown';
import {ShopField} from '../components/ShopField';
import {RecognitionReview, ReleaseEditor} from '../components/Recognition';

interface DraftSummary {id: string; updatedAt: string; photoCount: number; groupCount: number}
const statusLabels = {idle:'待识别',queued:'排队中',running:'识别中',done:'识别完成',error:'识别失败'};

export function openBatchForm(app: AppCtx) {
  app.openDrawer({title:'批量录入',asForm:true,workspace:true,content:<BatchForm/>});
}

export function BatchForm() {
  const app = useApp(); const {modules} = app;
  const [phase,setPhase] = useState('group');
  const [draft,setDraft] = useState<ImportDraft | null>(null);
  const current = useRef<ImportDraft | null>(null);
  const revision = useRef(0); const epoch = useRef(0); const pending = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const saveFailure = useRef<Error | null>(null);
  const [summaries,setSummaries] = useState<DraftSummary[]>([]);
  const [vision,setVision] = useState<VisionConfig | null>(null);
  const [error,setError] = useState(''); const [saveState,setSaveState] = useState('');
  const [uploading,setUploading] = useState(false); const uploadBusy = useRef(false);
  const [progress,setProgress] = useState({done:0,total:0});
  const [failures,setFailures] = useState<string[]>([]); const [committing,setCommitting] = useState(false);
  const [selected,setSelected] = useState<Set<string>>(new Set()); const [moveTarget,setMoveTarget] = useState('');
  const input = useRef<HTMLInputElement>(null); const alive = useRef(true);
  const common = useRef<ImportDraft['common']>({date:modules.acquisition ? today() : '',
    currency:modules.circulation && prefs.get('currency','JPY') !== 'CNY' ? 'JPY' : 'CNY',
    location:modules.acquisition ? prefs.get('location','') : '',storage:'',
    status:modules.circulation && prefs.get('currency','JPY') !== 'CNY' ? 'overseas' : 'domestic'});

  const accept = (d: ImportDraft) => {current.current=d;revision.current=d.revision;if(alive.current)setDraft(d);};
  useEffect(() => {
    alive.current=true;
    api<{drafts:DraftSummary[]}>('imports').then(r => {if(alive.current)setSummaries(r.drafts);}).catch(e => setError(e.message));
    api<VisionConfig>('vision').then(setVision).catch(() => {});
    return () => {alive.current=false;};
  },[]);
  useEffect(() => {app.setDrawerDirty(uploading || saveState==='保存中…' || saveState==='草稿未保存');},[uploading,saveState]);
  useEffect(() => {
    if (!draft?.id) return;
    const id=draft.id;
    const timer=window.setInterval(async () => {
      if (pending.current || uploadBusy.current || !current.current?.groups.some(g => g.status==='queued'||g.status==='running')) return;
      const generation=epoch.current;
      try {const d=await api<ImportDraft>('imports/draft?id='+id);if(alive.current && generation===epoch.current && !pending.current && !uploadBusy.current)accept(d);}
      catch(e) {if(alive.current)setError(e instanceof Error ? e.message : String(e));}
    },1200);
    return () => clearInterval(timer);
  },[draft?.id]);

  const ensure = async () => {
    if (current.current) return current.current;
    const d=await api<ImportDraft>('imports/create',{common:common.current});accept(d);return d;
  };
  const update = (fn: (d: ImportDraft) => ImportDraft) => {
    const d=current.current;if(!d)return;
    const next=fn(structuredClone(d));current.current=next;setDraft(next);
    const generation=++epoch.current;pending.current++;setSaveState('保存中…');setError('');
    chain.current=chain.current.then(async () => {
      const result=await api<ImportDraft>('imports/update',{id:next.id,revision:revision.current,common:next.common,groups:next.groups});
      revision.current=result.revision;
      saveFailure.current=null;
      if(generation===epoch.current && alive.current)accept(result);
    }).catch(e => {saveFailure.current=e;setError(e.message);throw e;}).finally(() => {
      pending.current--;if(alive.current)setSaveState(pending.current ? '保存中…' : saveFailure.current ? '草稿未保存' : '草稿已保存');
    });
    // 留给 flush 读取失败；下一次修改从失败链恢复，可再次保存当前草稿。
    const request=chain.current;request.catch(() => {});
    chain.current=request.catch(() => undefined);
  };
  const flush = async () => {await chain.current;if(saveFailure.current)throw saveFailure.current;};
  const field = (id: string,patch: Partial<RecognitionFields>) => update(d => {
    d.groups=d.groups.map(g => g.id===id ? {...g,fields:{...g.fields,...patch},protected:[...new Set([...g.protected,...Object.keys(patch)])],reviewed:false} : g);return d;
  });
  const flag = (id: string,patch: Partial<ImportGroup>) => update(d => {d.groups=d.groups.map(g => g.id===id ? {...g,...patch} : g);return d;});

  const addFiles = async (files: File[]) => {
    if (!files.length || uploadBusy.current || committing) return;
    uploadBusy.current=true;setUploading(true);setError('');setFailures([]);setProgress({done:0,total:files.length});
    try {
      await flush();const d=await ensure();
      for(let i=0;i<files.length;i++) {
        if(!alive.current)break;
        try {const data=await compressPhoto(files[i]);const next=await api<ImportDraft>('imports/upload',{id:d.id,name:files[i].name,data});accept(next);}
        catch(e) {const message=files[i].name+'：'+(e instanceof Error ? e.message : String(e));setFailures(prev => [...prev,message]);}
        setProgress({done:i+1,total:files.length});
      }
      setSaveState('草稿已保存');
    } catch(e) {setError(e instanceof Error ? e.message : String(e));}
    finally {uploadBusy.current=false;setUploading(false);}
  };
  const split = (id: string,index: number) => update(d => {
    const i=d.groups.findIndex(g => g.id===id);const g=d.groups[i];
    d.groups.splice(i,1,{...g,photoIds:g.photoIds.slice(0,index)}, {...newImportGroup(),photoIds:g.photoIds.slice(index)});return d;
  });
  const merge = (index: number) => update(d => {
    const before=d.groups[index-1],g=d.groups[index];
    d.groups.splice(index-1,2,{...before,photoIds:[...before.photoIds,...g.photoIds]});return d;
  });
  const move = (pids: string[],target: string,before?: string) => {
    update(d => {
      const dest=d.groups.find(g => g.id===target);if(!dest||dest.savedId)return d;
      if(d.groups.some(g => g.savedId && g.photoIds.some(p => pids.includes(p))))return d;
      for(const g of d.groups)g.photoIds=g.photoIds.filter(p => !pids.includes(p));
      const index=before ? dest.photoIds.indexOf(before) : -1;
      dest.photoIds.splice(index>=0 ? index : dest.photoIds.length,0,...pids);
      d.groups=d.groups.filter(g => g.photoIds.length || g.fields.title || g.fields.artist || g.id===target);return d;
    });setSelected(new Set());
  };
  const recognize = async (ids: string[]) => {
    setError('');try {await flush();const d=current.current;if(!d)return;accept(await api<ImportDraft>('imports/start',{id:d.id,groupIds:ids}));setPhase('review');}
    catch(e) {setError(e instanceof Error ? e.message : String(e));}
  };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();setCommitting(true);setError('');
    try {
      await flush();const d=current.current;if(!d)return;
      const ids=d.groups.filter(g => g.reviewed&&!g.excluded&&!g.savedId).map(g => g.id);
      const saved=await api<ImportDraft>('imports/commit',{id:d.id,groupIds:ids});accept(saved);await app.refresh();
      app.toast(`已入库 ${ids.length} 张，其他组仍保留在草稿中`);
    } catch(e) {setError(e instanceof Error ? e.message : String(e));}
    finally {setCommitting(false);}
  };
  const load = async (id: string) => {setError('');try {const loaded=await api<ImportDraft>('imports/draft?id='+id);accept(loaded);setPhase(loaded.groups.some(g => g.result) ? 'review' : 'group');setSelected(new Set());}catch(e){setError(e instanceof Error ? e.message : String(e));}};
  const editable=!(uploading||committing);
  const eligible=draft?.groups.filter(g => !g.savedId&&!g.excluded&&(g.status==='idle'||g.status==='error')&&g.photoIds.length>0&&g.photoIds.length<=MAX_PHOTOS) ?? [];
  const photos=new Map(draft?.photos.map(p => [p.id,p]) ?? []);
  const ready=draft?.groups.filter(g => g.reviewed&&!g.excluded&&!g.savedId&&g.status!=='queued'&&g.status!=='running') ?? [];

  return <form id="batch-form" className={`photo-import-form${phase==='group' ? ' grouping' : ''}`} onSubmit={submit}>
    <div className="drawer-body import-body">
      <div className="import-intro"><div><span className="import-step">照片 → 分组 → 识别 → 核对入库</span>
        <p>每组是一张实物副本。连续拍摄的照片，点分隔线即可切组；也可选图或拖图调整归属。</p></div>
        <span className="small-note" role="status">{uploading ? `处理照片 ${progress.done} / ${progress.total}` : saveState || '上传后自动保存草稿'}</span></div>
      <div className="error" role="alert">{error}</div>
      <div className="import-drop" onDragOver={e => {e.preventDefault();}} onDrop={e => {e.preventDefault();if(e.dataTransfer.files.length)void addFiles([...e.dataTransfer.files]);}}>
        <strong>{draft?.photos.length ? `${draft.photos.length} 张照片 · ${draft.groups.length} 组` : '把这一批专辑照片拖到这里'}</strong>
        <span>支持 JPG / PNG / WebP / HEIC，可一次选择很多张</span>
        <button type="button" disabled={!editable} onClick={() => input.current?.click()}>{uploading ? '上传中…' : draft ? '继续添加照片' : '选择一批照片'}</button>
        <input ref={input} type="file" accept="image/*,.heic,.heif" multiple hidden aria-label="选择批量专辑照片"
          onChange={e => {const files=[...(e.target.files??[])];e.target.value='';void addFiles(files);}}/>
      </div>
      {failures.length ? <details className="adv" open><summary>{failures.length} 张照片未成功，可重新选择这些文件</summary>{failures.map((f,i) => <p className="error" key={i}>{f}</p>)}</details> : null}
      {!draft && summaries.length ? <section className="draft-list"><h3>继续之前的草稿</h3>{summaries.map(s => <div key={s.id}>
        <button type="button" onClick={() => void load(s.id)}>{s.photoCount} 张照片 · {s.groupCount} 组 · {s.updatedAt.replace('T',' ')}</button>
        <button type="button" className="quiet" onClick={async () => {if(!confirm('删除这份未完成草稿及其中的暂存照片？已入库记录会保留。'))return;await api('imports/delete',{id:s.id});setSummaries(prev => prev.filter(x => x.id!==s.id));}}>删除草稿</button>
      </div>)}</section> : null}
      <div className="import-tools"><Seg ariaLabel="批量录入步骤" options={[{value:'group',label:'照片分组'},{value:'review',label:'资料核对'}]} value={phase} onValue={setPhase}/><button type="button" className="quiet" disabled={!editable} onClick={async () => {await ensure();setPhase('review');update(d => {d.groups.push(newImportGroup());return d;});}}>＋ 手动加一张</button>
        <button type="button" className="primary" disabled={!editable||!vision?.configured||!eligible.length} onClick={() => void recognize(eligible.map(g => g.id))}>识别全部未完成组{eligible.length ? `（${eligible.length}）` : ''}</button>
        {!vision?.configured ? <span className="small-note">在设置中配置模型后可识别；也可直接手工填写。</span> : <span className="small-note">同时识别 {vision.concurrency} 组 · 每组最多 {MAX_PHOTOS} 张照片</span>}
        {phase==='review'&&draft ? <button type="button" disabled={!editable} onClick={() => update(d => {const mark=!d.groups.some(g => g.reviewed&&!g.savedId&&!g.excluded);d.groups=d.groups.map(g => !g.savedId&&!g.excluded&&g.fields.title?.trim()&&g.fields.artist?.trim()&&g.status!=='queued'&&g.status!=='running' ? {...g,reviewed:mark} : g);return d;})}>{ready.length ? '取消全部勾选' : '全部勾选入库'}</button> : null}
      </div>
      {draft ? <details className="adv import-common" open={phase==='review'}><summary>这一批的共同资料</summary><div className="form-grid">
        {modules.acquisition ? <><div className="field"><label htmlFor="batch-date">买入日期（选填）</label><input id="batch-date" type="date" value={draft.common.date} disabled={!editable} onChange={e => update(d => {d.common.date=e.target.value;return d;})}/></div>
          <div className="field"><label>币种</label><Seg ariaLabel="整批币种" options={[{value:'JPY',label:'日元'},{value:'CNY',label:'人民币'}]} value={draft.common.currency} onValue={v => {if(editable)update(d => {d.common.currency=v as 'JPY'|'CNY';
            // 切日元即整批取整（与单张录入的币种切换同口径）；输入侧见下方 price 过滤
            if(v==='JPY')d.groups=d.groups.map(g => g.savedId||!g.fields.price ? g : {...g,fields:{...g.fields,price:String(Math.round(Number(g.fields.price)))}});
            return d;});}}/></div>
          <ShopField value={draft.common.location} records={app.state.records} defaultShop={prefs.get('location','')} onChange={value => {if(editable)update(d => {d.common.location=value;return d;});}}/></> : null}
        <div className="field"><label htmlFor="batch-storage">存放位置</label><input id="batch-storage" value={draft.common.storage} disabled={!editable} onChange={e => update(d => {d.common.storage=e.target.value;return d;})}/></div>
        {modules.circulation ? <div className="field"><label>入库位置</label><Seg ariaLabel="整批入库位置" options={[{value:'overseas',label:'海外库存'},{value:'domestic',label:'国内库存'}]} value={draft.common.status} onValue={v => {if(editable)update(d => {d.common.status=v as 'overseas'|'domestic';return d;});}}/></div> : null}
      </div></details> : null}
      <div className="import-groups">{draft?.groups.map((g,index) => <section className={`import-group${g.excluded ? ' excluded' : ''}`} key={g.id}
        onDragOver={e => e.preventDefault()} onDrop={e => {e.preventDefault();if(e.dataTransfer.files.length){void addFiles([...e.dataTransfer.files]);return;}const pid=e.dataTransfer.getData('application/diedu-photo');if(pid&&editable)move([pid],g.id);}}>
        <div className="import-group-head"><div><b>第 {index+1} 组</b><span>{g.photoIds.length} 张照片</span><span className={`import-status ${g.status}`}>{g.savedId ? '已入库' : statusLabels[g.status]}</span></div>
          {!g.savedId ? <div className="import-group-actions">
            {index>0&&!draft.groups[index-1].savedId ? <button type="button" disabled={!editable} onClick={() => merge(index)}>与前组合并</button> : null}
            <button type="button" disabled={!editable||!vision?.configured||!g.photoIds.length||g.photoIds.length>MAX_PHOTOS||g.status==='queued'||g.status==='running'} onClick={() => void recognize([g.id])}>{g.status==='done' ? '重新识别' : g.status==='error' ? '重试识别' : '识别这组'}</button>
            <button type="button" className="quiet" disabled={!editable} onClick={() => flag(g.id,{excluded:!g.excluded,reviewed:false})}>{g.excluded ? '恢复此组' : '跳过此组'}</button>
          </div> : null}</div>
        <div className="import-photo-line">{g.photoIds.map((pid,pi) => {const p=photos.get(pid);return p ? <div className="import-photo-unit" key={pid}>
          {pi>0&&!g.savedId ? <button type="button" className="photo-split" aria-label={`在第 ${index+1} 组第 ${pi+1} 张照片前分组`} title="在这里切成两组" disabled={!editable} onClick={() => split(g.id,pi)}>＋</button> : null}
          <div className="import-photo photo-thumb" draggable={editable&&!g.savedId} onDragStart={e => e.dataTransfer.setData('application/diedu-photo',pid)}
            onDrop={e => {const moved=e.dataTransfer.getData('application/diedu-photo');if(moved&&editable){e.preventDefault();e.stopPropagation();move([moved],g.id,pid);}}}>
            <img src={p.url} loading="lazy" alt={p.name}/>
            {!g.savedId ? <input type="checkbox" aria-label={`选择照片 ${p.name}`} checked={selected.has(pid)} disabled={!editable}
              onChange={e => setSelected(prev => {const next=new Set(prev);if(e.target.checked)next.add(pid);else next.delete(pid);return next;})}/> : null}
            <span>{pi+1}</span>
          </div><small title={p.name}>{p.name}</small>
        </div> : null;})}</div>
        {g.photoIds.length>MAX_PHOTOS ? <p className="recognition-warnings">这一组超过 {MAX_PHOTOS} 张照片，请先点击照片间的分隔线切组。</p> : null}
        {g.error ? <p className="error" role="alert">{g.error}</p> : null}
        <fieldset disabled={!editable||!!g.savedId||g.excluded} className="import-fields">
          <div className="import-basic-fields">{([['title','专辑名'],['artist','艺人'],...(modules.acquisition ? [['price','买入金额（选填）']] : []),['version','碟盒'],['pressing','日版／外版'],['obi','侧标']] as [keyof RecognitionFields,string][]).map(([key,label]) => <div className="field" key={key}>
            <label htmlFor={`${g.id}-${key}`}>{label}</label><input id={`${g.id}-${key}`} name={`batch-${key}`} value={String(g.fields[key]??'')}
              type={key==='price' ? 'number' : 'text'} min={key==='price' ? '0' : undefined}
              step={key==='price' ? (draft.common.currency==='JPY' ? 'any' : '0.01') : undefined}
              inputMode={key==='price' ? (draft.common.currency==='JPY' ? 'numeric' : 'decimal') : undefined}
              onChange={e => field(g.id,{[key]:key==='price'&&draft.common.currency==='JPY' ? e.target.value.replace(/[^\d]/g,'') : e.target.value})}/></div>)}</div>
          <details className="adv"><summary>发行资料与上架描述</summary><ReleaseEditor prefix={g.id} value={g.fields.releaseInfo??{}} onChange={releaseInfo => field(g.id,{releaseInfo})}/>
            <div className="field"><label htmlFor={`${g.id}-description`}>上架描述草稿</label><textarea id={`${g.id}-description`} value={g.fields.listingDescription??''} onChange={e => field(g.id,{listingDescription:e.target.value})}/></div>
            <button type="button" className="quiet" onClick={() => field(g.id,{listingDescription:listingText(g.fields)})}>从当前资料生成描述</button>
          </details>
          {g.result ? <RecognitionReview result={g.result} onRelease={(releaseInfo,source) => {
            if(!alive.current)return;
            const latest=current.current?.groups.find(x => x.id===g.id);
            if(!latest || latest.savedId || latest.excluded || latest.result?.at!==g.result?.at || latest.photoIds.join()!==g.photoIds.join())return;
            update(d => {const group=d.groups.find(x => x.id===g.id)!;group.fields.releaseInfo={...group.fields.releaseInfo,...Object.fromEntries(Object.entries(releaseInfo).filter(([,val]) => Array.isArray(val) ? val.length : val))};group.protected=[...new Set([...group.protected,'releaseInfo'])];group.reviewed=false;
              if(!group.protected.includes('listingDescription')) {group.fields.listingDescription=listingText(group.fields);group.protected.push('listingDescription');}
              // 来源由后端按候选 URL 验证保存。
              group.result={...group.result!,sources:[...group.result!.sources,source]};return d;});
          }}/> : null}
          <label className="check-line"><input type="checkbox" checked={g.reviewed} disabled={!g.fields.title?.trim()||!g.fields.artist?.trim()||g.status==='queued'||g.status==='running'} onChange={e => flag(g.id,{reviewed:e.target.checked})}/>已核对，加入本次入库</label>
        </fieldset>
      </section>)}</div>
    </div>
    {selected.size ? <div className="import-move-bar"><b>已选 {selected.size} 张照片</b><Dropdown id="photo-move-target" label="移动到哪个组" value={moveTarget}
      options={(draft?.groups.filter(g => !g.savedId) ?? []).map(g => ({value:g.id,label:`第 ${(draft?.groups.indexOf(g)??0)+1} 组`}))} onPick={setMoveTarget}/>
      <button type="button" disabled={!editable} onClick={() => {const target=moveTarget||draft?.groups.find(g => !g.savedId)?.id;if(target)move([...selected],target);}}>移入此组</button>
      <button type="button" disabled={!editable} onClick={() => {update(d => {for(const g of d.groups)if(!g.savedId)g.photoIds=g.photoIds.filter(pid => !selected.has(pid));return d;});setSelected(new Set());}}>移除所选照片</button>
      <button type="button" onClick={() => setSelected(new Set())}>取消选择</button></div> : null}
    <div className="drawer-footer import-footer"><span className="small-note">已核对 {ready.length} 组 · 保存后仍可继续处理剩余组</span>
      <button type="button" onClick={() => app.closeDrawer()}>{draft ? '关闭，保留草稿' : '取消'}</button>
      <button type="submit" className="primary" disabled={!ready.length||!editable}>{committing ? '入库中…' : `入库已核对的 ${ready.length} 组`}</button>
    </div>
  </form>;
}
