import type {RecognitionFields, RecognitionResult, ReleaseInfo} from '../types';
import {releaseLabels} from '../core/recognition';
import {useState} from 'react';
import {api} from '../core/api';

export function ReleaseEditor({value, onChange, prefix}: {
  value: ReleaseInfo; onChange: (value: ReleaseInfo) => void; prefix: string;
}) {
  return <div className="release-fields">
    {releaseLabels.map(([key,label]) => <div className="field" key={key}>
      <label htmlFor={`${prefix}-${key}`}>{label}</label>
      <input id={`${prefix}-${key}`} value={String(value[key] ?? '')}
        onChange={e => onChange({...value,[key]:e.target.value})}/>
    </div>)}
    <div className="field full"><label htmlFor={`${prefix}-tracks`}>曲目（每行一首）</label>
      <textarea id={`${prefix}-tracks`} value={(value.tracklist ?? []).join('\n')}
        onChange={e => onChange({...value,tracklist:e.target.value.split('\n')})}/></div>
  </div>;
}

export function RecognitionReview({result, onApply, onRelease}: {
  result: RecognitionResult; onApply?: (fields: RecognitionFields) => void;
  onRelease: (release: ReleaseInfo, source: {title: string; url: string}) => void;
}) {
  const [loading,setLoading] = useState('');
  const [message,setMessage] = useState('');
  return <section className="recognition-review" aria-label="识别依据与发行候选">
    {onApply ? <div className="recognition-summary">
      <div><strong>{result.fields.title || '名称待确认'}</strong><span>{result.fields.artist || '艺人待确认'}</span></div>
      <button type="button" className="primary" onClick={() => onApply(result.fields)}>补全空白字段</button>
    </div> : null}
    {result.warnings.length ? <ul className="recognition-warnings">{result.warnings.map((w,i) => <li key={i}>{w}</li>)}</ul> : null}
    {result.candidates.length ? <details className="adv">
      <summary>发行候选 · {result.candidates.length} 个</summary>
      {result.candidates.map(c => <div className="release-candidate" key={c.id}>
        <div><a href={c.url} target="_blank" rel="noopener noreferrer">{c.title} ↗</a>
          <p>{[c.artist,c.releaseInfo.catalogNumber,c.releaseInfo.country,c.releaseInfo.releaseDate,c.releaseInfo.edition].filter(Boolean).join(' · ')}</p>
          <small>{c.identifierMatch ? '实物编号匹配，仍请核对版本' : '名称检索候选，版本待核对'}</small></div>
        <button type="button" disabled={!!loading} onClick={async () => {
          setLoading(c.id);setMessage('');
          try {const detail=await api<{releaseInfo:ReleaseInfo}>('vision/release?id='+c.id);onRelease(detail.releaseInfo,{title:'MusicBrainz 人工选择',url:c.url});}
          catch {onRelease(c.releaseInfo,{title:'MusicBrainz 人工选择',url:c.url});setMessage('已采用候选的基础资料，详细曲目暂不可用。');}
          finally {setLoading('');}
        }}>{loading===c.id ? '补全曲目中…' : '采用发行资料'}</button>
      </div>)}
    </details> : null}
    {message ? <p className="small-note" role="status">{message}</p> : null}
    <details className="adv"><summary>照片依据与资料来源</summary>
      <p className="small-note">{result.model} · {result.at.replace('T',' ')}</p>
      {result.evidence.map((e,i) => <p className="recognition-evidence" key={i}>照片 {e.photo} · {e.value || e.field}{e.note ? `：${e.note}` : ''}</p>)}
      {!result.evidence.length ? <p className="small-note">模型未给出逐项照片依据，请对照实物核对。</p> : null}
      {result.sources.map((s,i) => <a className="recognition-source" href={s.url} target="_blank" rel="noopener noreferrer" key={i}>{s.title} ↗</a>)}
    </details>
  </section>;
}
