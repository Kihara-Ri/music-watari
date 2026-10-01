// 记录售出 / 合单售出表单：分组列表行（手机友好，label 左、值右）+ 实时预览到手
// 与预估利润，多张按张数均摊。日期用「今天/昨天/选日期」快捷块，渠道用历史渠道块。
import {useState} from 'react';
import {api} from '../core/api';
import {prefs} from '../core/prefs';
import {sum, today, yuan} from '../core/format';
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import {Field, TextareaField} from './fields';
import {AlbumLine} from '../components/SaleCard';
import {useFormSubmit} from './shared';

export function openSaleForm(app: AppCtx, ids: string[]) {
  const rs = ids.map(app.rec).filter(Boolean);
  app.openDrawer({
    title: rs.length > 1 ? '合单售出' : '记录售出',
    asForm: true,
    content: <SaleForm ids={ids}/>,
  });
}

const yesterday = (): string => {
  const d = new Date(Date.now() - 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// 历史售出渠道按频次排序，取前 6（与购买渠道 ShopField 同一套归并思路）
function saleChannels(channels: string[]): string[] {
  const freq = new Map<string, number>();
  channels.forEach(c => { if (c) freq.set(c, (freq.get(c) || 0) + 1); });
  return [...freq.keys()].sort((a, b) => freq.get(b)! - freq.get(a)! || a.localeCompare(b, 'zh')).slice(0, 6);
}

function SaleForm({ids}: {ids: string[]}) {
  const app = useApp();
  const {error, saving, run} = useFormSubmit();
  const [v, setV] = useState({
    gross: '', date: today(), fees: '0', postage: '0',
    channel: prefs.get('saleChannel', '闲鱼'), address: '',
    orderId: '', note: '',
  });
  const [customChannel, setCustomChannel] = useState(false);
  const set = (patch: Partial<typeof v>) => { setV(prev => ({...prev, ...patch})); app.setDrawerDirty(true); };
  const rs = ids.map(app.rec).filter((r): r is NonNullable<typeof r> => !!r);
  const unknown = rs.some(r => r.cost === null);
  const csum = sum(rs, 'cost');
  const net = v.gross === '' ? null : Number(v.gross) - Number(v.fees || 0) - Number(v.postage || 0);

  const hist = saleChannels(app.state.sales.map(s => s.channel));
  const channels = v.channel && !hist.includes(v.channel) ? [v.channel, ...hist] : hist;
  const dToday = today();
  const dYesterday = yesterday();
  const datePreset = v.date === dToday ? 'today' : v.date === dYesterday ? 'yesterday' : 'custom';
  const profit = net === null ? null : Number((net - csum).toFixed(2));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(app, async () => {
      prefs.set('saleChannel', v.channel);
      await api('sales', {...v, ids});
    });
  };

  const pickDate = (e: React.MouseEvent<HTMLLabelElement>) => {
    const inp = e.currentTarget.querySelector<HTMLInputElement>('input[type=date]');
    if (!inp) return;
    try { inp.showPicker(); } catch { /* 旧浏览器退回 label 激活 */ }
  };

  return (
    <form id="sale-form" onSubmit={submit}>
      <div className="drawer-body">
        <div className="error" role="alert">{error}</div>
        {rs.map(r => r && <AlbumLine key={r.id} r={r} showCost={app.modules.acquisition}/>)}
        <div className="row-group">
          <div className="row amount-row">
            <label htmlFor="f-gross">成交价</label>
            <div className="row-value amount">
              <input id="f-gross" name="gross" type="number" required min="0" step="0.01"
                     inputMode="decimal" placeholder="0.00" value={v.gross}
                     onChange={e => set({gross: e.target.value})}/>
              <span className="unit">元</span>
            </div>
          </div>
          <div className="row">
            <label>售出日期</label>
            <div className="row-value chips" role="group" aria-label="售出日期">
              <button type="button" className={`chip${datePreset === 'today' ? ' on' : ''}`}
                      onClick={() => set({date: dToday})}>今天</button>
              <button type="button" className={`chip${datePreset === 'yesterday' ? ' on' : ''}`}
                      onClick={() => set({date: dYesterday})}>昨天</button>
              <label className={`chip${datePreset === 'custom' ? ' on' : ''}`} onClick={pickDate}>
                {datePreset === 'custom' ? `${Number(v.date.slice(5, 7))}月${Number(v.date.slice(8, 10))}日` : '选日期'}
                <input className="vh-date" type="date" value={v.date}
                       onChange={e => e.target.value && set({date: e.target.value})}/>
              </label>
            </div>
          </div>
          <div className="row">
            <label htmlFor="f-fees">平台扣费</label>
            <div className="row-value">
              <input id="f-fees" name="fees" type="number" min="0" step="0.01" inputMode="decimal"
                     placeholder="0" value={v.fees} onChange={e => set({fees: e.target.value})}/>
              <span className="unit">元</span>
            </div>
          </div>
          <div className="row">
            <label htmlFor="f-postage">寄出运费</label>
            <div className="row-value">
              <input id="f-postage" name="postage" type="number" min="0" step="0.01" inputMode="decimal"
                     placeholder="0" value={v.postage} onChange={e => set({postage: e.target.value})}/>
              <span className="unit">元</span>
            </div>
          </div>
          <div className="row">
            <label>渠道</label>
            <div className="row-value chips">
              {channels.map(c => (
                <button type="button" key={c} className={`chip${v.channel === c && !customChannel ? ' on' : ''}`}
                        onClick={() => { set({channel: c}); setCustomChannel(false); }}>{c}</button>
              ))}
              <button type="button" className={`chip${customChannel ? ' on' : ''}`} aria-label="自定义渠道"
                      onClick={() => setCustomChannel(x => !x)}>＋</button>
            </div>
          </div>
          {customChannel ? (
            <div className="row">
              <label htmlFor="f-channel">自定义</label>
              <div className="row-value">
                <input id="f-channel" name="channel" placeholder="输入渠道名称" value={v.channel}
                       onChange={e => set({channel: e.target.value})}/>
              </div>
            </div>
          ) : null}
        </div>
        <div className="preview sale-preview">
          <div className="line">
            <b>{net === null ? '—' : yuan(net)}</b><span>预计到手</span>
            {app.modules.acquisition && net !== null && !unknown ? <>
              <span className="hint">· 预估利润</span>
              <span className={profit! < 0 ? 'negative' : 'positive'}>{yuan(profit)}</span>
            </> : null}
            {app.modules.acquisition && unknown ? <span className="hint">· 成本待补，利润稍后自动补齐</span> : null}
            {rs.length > 1 ? <span className="hint">· 多张按张数均摊</span> : null}
          </div>
          <p>买家签收、钱款到账后点「确认收货」转为已售出。</p>
        </div>
        <details className="adv">
          <summary>更多信息</summary>
          <div className="form-grid">
            <Field label="买家地址（选填）" name="address" placeholder="用于后续数据分析"
                   value={v.address} onChange={e => set({address: e.target.value})}/>
            <Field label="订单号" name="orderId" value={v.orderId} onChange={e => set({orderId: e.target.value})}/>
            <TextareaField label="备注" name="sale-note" value={v.note} onChange={val => set({note: val})}/>
          </div>
        </details>
      </div>
      <div className="drawer-footer">
        <button type="button" onClick={() => app.closeDrawer()}>取消</button>
        <button type="submit" className="primary" disabled={saving}>确认售出</button>
      </div>
    </form>
  );
}
