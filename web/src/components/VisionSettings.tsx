import {useEffect, useState} from 'react';
import {api} from '../core/api';
import type {VisionConfig} from '../types';

export function VisionSettings() {
  const [config,setConfig] = useState<VisionConfig | null>(null);
  const [key,setKey] = useState(''); const [clear,setClear] = useState(false);
  const [saving,setSaving] = useState(false); const [message,setMessage] = useState('');
  const [failed,setFailed] = useState(false);
  useEffect(() => { api<VisionConfig>('vision').then(setConfig).catch(e => {setMessage(e.message);setFailed(true);}); },[]);
  return <section className="settings-section">
    <h3>照片识别</h3><p>配置支持多图片输入的 OpenAI 兼容视觉模型，录入时按需识别。照片会发送到你填写的服务。</p>
    {config ? <form onSubmit={async e => {
      e.preventDefault();setSaving(true);setMessage('');
      try {const saved=await api<VisionConfig>('vision/config',{...config,apiKey:key,clearKey:clear});setConfig(saved);setKey('');setClear(false);setFailed(false);setMessage('配置已保存，可在录入面板中识别照片。');}
      catch(err) {setFailed(true);setMessage(err instanceof Error ? err.message : String(err));}
      finally {setSaving(false);}
    }}>
      <div className="vision-config-grid">
        <label>服务地址<input type="url" aria-label="视觉服务地址" placeholder="https://your.domain/v1" value={config.baseUrl}
          onChange={e => setConfig({...config,baseUrl:e.target.value})}/></label>
        <label>模型名<input aria-label="视觉模型名" placeholder="服务支持的视觉模型名称" value={config.model}
          onChange={e => setConfig({...config,model:e.target.value})}/></label>
        <label>API 密钥<input type="password" aria-label="视觉 API 密钥" autoComplete="new-password" value={key}
          placeholder={config.hasKey ? '已保存，留空保留原密钥' : '本地服务可留空'} onChange={e => setKey(e.target.value)}/></label>
        <label>同时识别组数<input type="number" min="1" max="6" step="1" aria-label="同时识别组数" value={config.concurrency}
          onChange={e => setConfig({...config,concurrency:Number(e.target.value)})}/></label>
      </div>
      <label className="check-line"><input type="checkbox" checked={config.lookup} onChange={e => setConfig({...config,lookup:e.target.checked})}/>联网补全发行资料与封面（MusicBrainz / iTunes）</label>
      {config.hasKey ? <label className="check-line"><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)}/>清除已保存的密钥</label> : null}
      <button className="primary" disabled={saving}>{saving ? '保存中…' : '保存识别配置'}</button>
    </form> : null}
    <p className={failed ? 'error' : 'small-note'} role="status">{message}</p>
  </section>;
}
