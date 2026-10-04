import {useEffect, useState} from 'react';
import {api} from '../core/api';
import {Dropdown} from './ui/Dropdown';
import type {VisionConfig, VisionProvider} from '../types';

const CUSTOM = 'custom';

export function VisionSettings() {
  const [config,setConfig] = useState<VisionConfig | null>(null);
  const [providers,setProviders] = useState<VisionProvider[]>([]);
  const [key,setKey] = useState(''); const [clear,setClear] = useState(false);
  const [manual,setManual] = useState(false);
  const [loginUrl,setLoginUrl] = useState(''); const [pasteUrl,setPasteUrl] = useState('');
  const [loginBusy,setLoginBusy] = useState(false);
  const [saving,setSaving] = useState(false); const [message,setMessage] = useState('');
  const [failed,setFailed] = useState(false);
  useEffect(() => {
    api<VisionConfig>('vision').then(c => {
      setConfig(c);
      return api<{providers:VisionProvider[]}>('vision/providers').then(r => {
        setProviders(r.providers);
        const known = r.providers.find(p => p.id === c.provider);
        // 已存的模型名不在目录建议里（或本身就是自定义服务）时，直接进手动输入。
        setManual(!known || (!!c.model && !known.models.some(m => m.id === c.model)));
      });
    }).catch(e => {setMessage(e.message);setFailed(true);});
  },[]);
  const known = config ? providers.find(p => p.id === config.provider) : undefined;
  const oauth = !!known?.oauth;
  const providerOptions = [{value:'',label:'选择供应商…'},
    ...providers.map(p => ({value:p.id,label:p.name})), {value:CUSTOM,label:'自定义 OpenAI 兼容服务'}];
  const modelOptions = known && known.models.length
    ? [...known.models.map(m => ({value:m.id,label:`${m.name}（${m.id}）`})), {value:'__manual__',label:'手动输入模型名…'}] : [];
  const pickProvider = (v:string) => {
    if (!config) return;
    const next = providers.find(p => p.id === v);
    // 密钥状态按供应商隔离：切换后旧状态不再适用，保存后由服务端回传真值。
    setConfig({...config, provider:v, baseUrl:next ? next.baseUrl : '', model:'', hasKey:false, keySource:''});
    setManual(false); setKey(''); setClear(false); setLoginUrl(''); setPasteUrl('');
  };
  const pickModel = (v:string) => {
    if (!config) return;
    if (v === '__manual__') { setManual(true); return; }
    setConfig({...config, model:v});
  };
  const envName = (config?.provider && known?.env) || config?.envName || '';
  const keyPlaceholder = !config ? '' :
    config.keySource === 'env' ? `当前由环境变量 ${envName} 提供，填写后覆盖` :
    config.hasKey ? '已保存，留空保留原密钥' :
    envName ? `留空则读取环境变量 ${envName}` : '本地服务可留空';
  const run = async (fn: () => Promise<void>) => {
    setLoginBusy(true); setMessage(''); setFailed(false);
    try { await fn(); }
    catch(err) {setFailed(true);setMessage(err instanceof Error ? err.message : String(err));}
    finally {setLoginBusy(false);}
  };
  const startLogin = () => run(async () => {
    const r = await api<{url:string}>('vision/codex/login',{});
    setLoginUrl(r.url); setPasteUrl('');
  });
  const finishLogin = () => run(async () => {
    const saved = await api<VisionConfig>('vision/codex/callback',{url:pasteUrl});
    setConfig(saved); setLoginUrl(''); setPasteUrl(''); setMessage('ChatGPT 登录成功。');
  });
  const doLogout = () => run(async () => {
    const saved = await api<VisionConfig>('vision/codex/logout',{});
    setConfig(saved); setLoginUrl(''); setPasteUrl(''); setMessage('已退出 ChatGPT 登录。');
  });
  return <section className="settings-section">
    <h3>照片识别</h3><p>从供应商目录选择视觉模型服务并完成认证，录入时按需识别。照片会发送到所选供应商的官方接口；选自定义服务时发送到你填写的地址。</p>
    {config ? <form onSubmit={async e => {
      e.preventDefault();setSaving(true);setMessage('');
      try {const saved=await api<VisionConfig>('vision/config',{...config,apiKey:key,clearKey:clear});
        setConfig(saved);setKey('');setClear(false);setFailed(false);setMessage('配置已保存，可在录入面板中识别照片。');}
      catch(err) {setFailed(true);setMessage(err instanceof Error ? err.message : String(err));}
      finally {setSaving(false);}
    }}>
      <div className="vision-config-grid">
        <div className="field"><label>供应商</label>
          <Dropdown id="vision-provider" value={config.provider} options={providerOptions}
                    label="视觉服务供应商" onPick={pickProvider}/>
        </div>
        {known ? <div className="field"><label>服务地址</label>
          <code className="vision-endpoint">{config.baseUrl}</code>
        </div> : <div className="field"><label htmlFor="vision-base">服务地址</label>
          <input id="vision-base" type="url" aria-label="视觉服务地址" placeholder="https://your.domain/v1"
                 value={config.baseUrl} onChange={e => setConfig({...config,baseUrl:e.target.value})}/>
        </div>}
        {known && modelOptions.length > 0 && !manual ? <div className="field"><label>模型</label>
          <Dropdown id="vision-model" value={config.model}
                    options={[{value:'',label:'选择模型…'}, ...modelOptions]}
                    label="视觉模型" onPick={pickModel}/>
        </div> : <div className="field"><label htmlFor="vision-model-input">模型名</label>
          <input id="vision-model-input" aria-label="视觉模型名" placeholder="服务支持的视觉模型名称"
                 value={config.model} onChange={e => setConfig({...config,model:e.target.value})}/>
          {known && modelOptions.length > 0 ?
            <button type="button" className="vision-back" onClick={() => {setManual(false);setConfig({...config,model:''});}}>从目录选择</button> : null}
        </div>}
        {oauth ? <div className="field vision-login"><label>ChatGPT 账号</label>
          {config.login?.state === 'ok' ? <div className="vision-login-row">
            <span className="vision-login-ok">已登录 · 授权到期 {new Date(config.login.expires).toLocaleString()}（识别时自动续期）</span>
            <button type="button" className="vision-back" disabled={loginBusy} onClick={doLogout}>退出登录</button>
          </div> : <>
            <span className="vision-login-hint">
              {config.login?.state === 'expired' ? '授权已过期，请重新登录。' : ''}需 ChatGPT Plus/Pro 订阅。生成登录链接并在浏览器中登录；登录后浏览器会跳到一个打不开的 localhost 页面——这是正常的，把地址栏完整网址粘贴回这里完成绑定。
            </span>
            {loginUrl ? <a className="vision-login-link" href={loginUrl} target="_blank" rel="noreferrer">打开 ChatGPT 授权页 ↗</a>
              : <button type="button" disabled={loginBusy} onClick={startLogin}>{loginBusy ? '生成中…' : '生成登录链接'}</button>}
            {loginUrl ? <>
              <input aria-label="粘贴回调网址" placeholder="粘贴 localhost:1455/auth/callback?code=… 完整网址"
                     value={pasteUrl} onChange={e => setPasteUrl(e.target.value)}/>
              <button type="button" className="primary" disabled={loginBusy || !pasteUrl.trim()} onClick={finishLogin}>
                {loginBusy ? '验证中…' : '完成登录'}</button>
            </> : null}
          </>}
        </div> : <div className="field"><label htmlFor="vision-key">API 密钥</label>
          <input id="vision-key" type="password" autoComplete="new-password" value={key}
                 placeholder={keyPlaceholder} onChange={e => setKey(e.target.value)}/>
        </div>}
        <div className="field"><label htmlFor="vision-concurrency">同时识别组数</label>
          <input id="vision-concurrency" type="number" min="1" max="6" step="1" aria-label="同时识别组数"
                 value={config.concurrency} onChange={e => setConfig({...config,concurrency:Number(e.target.value)})}/>
        </div>
      </div>
      <label className="check-line"><input type="checkbox" checked={config.lookup} onChange={e => setConfig({...config,lookup:e.target.checked})}/>联网补全发行资料与封面（MusicBrainz / iTunes）</label>
      {!oauth && config.hasKey ? <label className="check-line"><input type="checkbox" checked={clear} onChange={e => setClear(e.target.checked)}/>清除该供应商已保存的密钥</label> : null}
      <button className="primary" disabled={saving || !config.provider}>{saving ? '保存中…' : '保存识别配置'}</button>
    </form> : null}
    <p className={failed ? 'error' : 'small-note'} role="status">{message}</p>
  </section>;
}
