// 设置页：自动化服务状态、导入 albums.json、备份与恢复、回收站入口、最近操作、退出登录。
import {useEffect, useRef, useState} from 'react';
import {api} from '../core/api';
import {useApp} from '../state/AppContext';
import type {BackupFile} from '../types';
import {PageHead} from '../components/PageHead';
import {ModuleChooser} from '../components/ModuleChooser';
import {VisionSettings} from '../components/VisionSettings';
import {CONFIRM_TITLES, ConfirmForm} from '../forms/ConfirmForm';
import {Seg} from '../components/ui/Seg';
import type {ThemePref} from '../core/theme';

interface ImportPreview {
  count: number;
  skipped: number;
  errors: string[];
  titles: string[];
}

// 绑定书签：在 RYM 艺人页点击，把当前链接回传给碟渡（no-cors + 令牌鉴权）
function rymBindlet(origin: string, token: string): string {
  const endpoint = JSON.stringify(origin + '/api/artist-bind');
  const tok = JSON.stringify(token);
  return `javascript:(function(){if(!/^https:\\/\\/rateyourmusic\\.com\\/artist\\//.test(location.href)){alert('请在 RateYourMusic 的艺人页面上使用');return;}fetch(${endpoint},{method:'POST',mode:'no-cors',headers:{'Content-Type':'text/plain'},body:JSON.stringify({token:${tok},title:document.title,url:location.href})}).then(function(){alert('已发送，回碟渡确认绑定结果');},function(){alert('发送失败：无法连接碟渡');});})()`;
}

export function SettingsPage() {
  const app = useApp();
  const {state} = app;
  const trash = state.records.filter(r => r.status === 'trash').length;
  const [importResult, setImportResult] = useState<ImportPreview | null>(null);
  const [importData, setImportData] = useState<unknown[] | null>(null);
  const [importError, setImportError] = useState('');
  const [committing, setCommitting] = useState(false);
  const [rym, setRym] = useState<{links: Record<string, string>; token: string} | null>(null);
  const [pw, setPw] = useState({current: '', next: '', confirm: ''});
  const [changing, setChanging] = useState(false);
  const bindletAnchor = useRef<HTMLAnchorElement>(null);

  // 拉取绑定与令牌（首次访问会在服务端生成令牌）
  useEffect(() => {
    api<{links: Record<string, string>; token: string}>('artist-links')
      .then(setRym)
      .catch(() => { /* 离线时隐藏本节功能 */ });
  }, []);

  useEffect(() => {
    if (rym && bindletAnchor.current) {
      // 不走 React 的 href 属性（javascript: URL），挂载后直接设置
      bindletAnchor.current.setAttribute('href', rymBindlet(location.origin, rym.token));
    }
  }, [rym]);

  const copyBindlet = async () => {
    if (!rym) return;
    try {
      await navigator.clipboard.writeText(rymBindlet(location.origin, rym.token));
      app.toast('书签代码已复制，粘贴到书签的网址栏即可');
    } catch {
      app.toast('复制失败，请手动选择代码复制', 'err');
    }
  };

  const onImportFile = async (file: File) => {
    setImportError('');
    try {
      const data = JSON.parse(await file.text());
      const p = await api<ImportPreview>('import-preview', {albums: data});
      setImportData(data);
      setImportResult(p);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
    }
  };

  const onRestoreFile = async (file: File) => {
    try {
      const data = JSON.parse(await file.text()) as BackupFile;
      if (data.format !== 'album-ledger') throw new Error('请选择通过本系统下载的完整备份');
      app.openDrawer({
        title: CONFIRM_TITLES.restore,
        asForm: true,
        content: <ConfirmForm kind="restore" restoreData={data}/>,
      });
    } catch (err) {
      app.toast(err instanceof Error ? err.message : String(err), 'err');
    }
  };

  const logout = async () => {
    await api('logout', {});
    location.replace('/login');
  };

  // 改密：服务端会踢掉其他设备；本机模式（未启用登录）不渲染此节
  const changePassword = async () => {
    if (pw.next.length < 12) { app.toast('新密码至少需要 12 个字符', 'err'); return; }
    if (pw.next !== pw.confirm) { app.toast('两次输入的新密码不一致', 'err'); return; }
    setChanging(true);
    try {
      await api('password', {current: pw.current, next: pw.next});
      app.toast('密码已更改，其他设备已退出登录');
      setPw({current: '', next: '', confirm: ''});
    } catch (err) {
      app.toast(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      setChanging(false);
    }
  };

  return (
    <>
      <PageHead title="设置与备份" label="KEEP IT IN ORDER"/>
      <section className="settings-section">
        <h3>外观</h3>
        <p>浅色与深色主题可手动固定，跟随系统则随设备外观自动切换。</p>
        <Seg ariaLabel="外观模式" className="theme-seg"
             options={[{value: 'light', label: '浅色'}, {value: 'dark', label: '深色'}, {value: 'system', label: '跟随系统'}]}
             value={app.theme} onValue={v => app.setTheme(v as ThemePref)}/>
      </section>
      <section className="settings-section">
        <h3>功能模块</h3>
        <p>按需要选择收藏、购入记录、二手交易与海外周转。</p>
        {state.modules ? <ModuleChooser/> : <p className="small-note">当前后端仍是旧版本。重启碟渡服务后，即可选择功能模块；原有账本可以继续使用。</p>}
      </section>
      <section className="settings-section">
        <h3>自动化服务</h3>
        <p>封面从 iTunes / MusicBrainz 公开资料库自动抓取。{app.modules.acquisition ? '日元成本按购买当天汇率自动折算，无需手动维护。' : ''}</p>
        <p className="small-note">
          版本 {state.service?.version || 'dev'}{app.modules.acquisition ? <> · 汇率缓存：{state.rateService
            ? `${state.rateService.days} 天（最新 ${state.rateService.latest || '—'}）`
            : '不可用'}</> : null}
          {' '}· 最近备份：{state.service?.backup?.last || '尚未生成'}
        </p>
        {state.service?.backup?.error
          ? <p className="small-note" style={{color: 'var(--red)'}}>{state.service.backup.error}</p> : null}
      </section>

      <VisionSettings/>
      <section className="settings-section">
        <h3>导入专辑资料</h3>
        <p>支持 albums.json 格式（先预览再导入，重复来源自动跳过）。{app.modules.circulation ? '按买入币种进入海外或国内库存。' : '导入后进入我的收藏，原始购买资料会保留。'}</p>
        <div className="inline-actions">
          <label className="file-label">选择 JSON 文件
            <input type="file" accept=".json,application/json" aria-label="选择专辑导入文件" hidden
                   onChange={e => { const f = e.target.files?.[0]; if (f) onImportFile(f); e.target.value = ''; }}/>
          </label>
        </div>
        <div>
          {importError ? <p className="error" role="alert">{importError}</p> : null}
          {importResult && (
            <div className="import-preview">
              <strong>新增 {importResult.count} 条 · 已存在 {importResult.skipped} 条</strong>
              {importResult.errors.length ? (
                <p className="error">{importResult.errors.join('\n')}</p>
              ) : (
                <>
                  <ul>{importResult.titles.map(t => <li key={t}>{t}</li>)}</ul>
                  <button className="primary" disabled={!importResult.count || committing}
                          onClick={async () => {
                            if (importData === null) return;
                            setCommitting(true);
                            try {
                              const r = await api<{count: number}>('import', {albums: importData});
                              await app.refresh();
                              app.toast(`已导入 ${r.count} 条`);
                              setImportResult(null);
                              setImportData(null);
                            } catch (err) {
                              app.toast(err instanceof Error ? err.message : String(err), 'err');
                            } finally {
                              setCommitting(false);
                            }
                          }}>导入</button>
                </>
              )}
            </div>
          )}
        </div>
      </section>

      <section className="settings-section">
        <h3>RYM 艺人直达</h3>
        <p>「按艺人」视图点艺人名默认打开 RateYourMusic 搜索。在搜索结果里选中艺人进入其页面后，点下面的书签，碟渡即记住该艺人的直达链接——之后点击艺人名直接进入艺人页，绑定随备份保存。</p>
        {rym ? (
          <div className="inline-actions">
            <a ref={bindletAnchor} className="link-button" draggable
               title="把这个按钮拖到浏览器书签栏" onClick={e => e.preventDefault()}>绑定到碟渡</a>
            <button onClick={copyBindlet}>复制书签代码</button>
            <span className="small-note">已绑定 {rym.links ? Object.keys(rym.links).length : 0} 位艺人</span>
          </div>
        ) : (
          <p className="small-note">绑定服务不可用（离线或未登录）。</p>
        )}
        <p className="small-note">书签只认 rateyourmusic.com/artist/ 页面；发送的内容仅页面标题与网址，凭据仅存在于本机服务。</p>
      </section>

      <section className="settings-section">
        <h3>完整备份与恢复</h3>
        <p>备份包含所有专辑、发行资料、上架描述、封面、包裹与交易。实物照片、录入草稿与模型配置需另行备份数据目录。恢复会替换当前账本，恢复前会自动保存当前状态。</p>
        <div className="inline-actions">
          <a className="link-button" href="/api/export">导出专辑 CSV</a>
          <a className="link-button" href="/api/backup">下载完整备份</a>
          <label className="file-label">恢复备份
            <input type="file" accept=".json,application/json" aria-label="选择完整备份" hidden
                   onChange={e => { const f = e.target.files?.[0]; if (f) onRestoreFile(f); e.target.value = ''; }}/>
          </label>
        </div>
      </section>

      <section className="settings-section">
        <h3>回收站</h3>
        <p>{trash} 张已移除专辑可以恢复。</p>
        <div className="inline-actions"><a className="link-button" href="#trash">打开回收站</a></div>
      </section>

      <section className="settings-section">
        <h3>最近操作</h3>
        <div>
          {state.audit.slice(-10).reverse().map((a, i) => (
            <p className="small-note" key={i}>{a.at.replace('T', ' ')} · {a.action}</p>
          ))}
          {!state.audit.length && <p>暂无操作记录。</p>}
        </div>
      </section>

      {state.service?.login ? (
        <section className="settings-section">
          <h3>登录密码</h3>
          <p>更改后其他已登录设备会全部退出，需用新密码重新登录；当前设备保持登录。</p>
          <div className="pw-change">
            <input type="password" placeholder="当前密码" autoComplete="current-password" maxLength={1024}
                   aria-label="当前密码" value={pw.current}
                   onChange={e => setPw({...pw, current: e.target.value})}/>
            <input type="password" placeholder="新密码（至少 12 位）" autoComplete="new-password" maxLength={1024}
                   aria-label="新密码" value={pw.next}
                   onChange={e => setPw({...pw, next: e.target.value})}/>
            <input type="password" placeholder="再输入一次新密码" autoComplete="new-password" maxLength={1024}
                   aria-label="确认新密码" value={pw.confirm}
                   onChange={e => setPw({...pw, confirm: e.target.value})}/>
            <button className="primary" disabled={changing || !pw.current || !pw.next || !pw.confirm}
                    onClick={changePassword}>更改密码</button>
          </div>
        </section>
      ) : null}

      <section className="settings-section">
        <h3>访问</h3>
        <p>手机可通过浏览器菜单「添加到主屏幕」安装。</p>
        {state.service?.login ? <button onClick={logout}>退出登录</button> : null}
      </section>
    </>
  );
}
