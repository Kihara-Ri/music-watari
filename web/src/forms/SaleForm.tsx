// 记录售出 / 合单售出表单：实时预览到手与预估利润，多张按张数均摊。
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

function SaleForm({ids}: {ids: string[]}) {
  const app = useApp();
  const {error, saving, run} = useFormSubmit();
  const [v, setV] = useState({
    gross: '', date: today(), fees: '0', postage: '0',
    channel: prefs.get('saleChannel', '闲鱼'), address: '',
    orderId: '', note: '',
  });
  const set = (patch: Partial<typeof v>) => { setV(prev => ({...prev, ...patch})); app.setDrawerDirty(true); };
  const rs = ids.map(app.rec).filter((r): r is NonNullable<typeof r> => !!r);
  const unknown = rs.some(r => r.cost === null);
  const csum = sum(rs, 'cost');
  const net = v.gross === '' ? null : Number(v.gross) - Number(v.fees || 0) - Number(v.postage || 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(app, async () => {
      prefs.set('saleChannel', v.channel);
      await api('sales', {...v, ids});
    });
  };

  return (
    <form id="sale-form" onSubmit={submit}>
      <div className="drawer-body">
        <div className="error" role="alert">{error}</div>
        {rs.map(r => r && <AlbumLine key={r.id} r={r} showCost={app.modules.acquisition}/>)}
        <div className="form-grid form-section">
          <Field label="成交价（买家支付，元）" name="gross" type="number" required min="0" step="0.01"
                 inputMode="decimal" value={v.gross} onChange={e => set({gross: e.target.value})}/>
          <Field label="售出日期" name="sale-date" type="date" required value={v.date}
                 onChange={e => set({date: e.target.value})}/>
          <Field label="平台扣费（元）" name="fees" type="number" min="0" step="0.01" inputMode="decimal"
                 value={v.fees} onChange={e => set({fees: e.target.value})}/>
          <Field label="寄出运费（元）" name="postage" type="number" min="0" step="0.01" inputMode="decimal"
                 value={v.postage} onChange={e => set({postage: e.target.value})}/>
          <Field label="渠道" name="channel" placeholder="闲鱼" value={v.channel}
                 onChange={e => set({channel: e.target.value})}/>
          <Field label="买家地址（选填）" name="address" placeholder="用于后续数据分析"
                 value={v.address} onChange={e => set({address: e.target.value})}/>
        </div>
        <div className="preview">
          <strong>{net === null ? '—' : yuan(net)}</strong>
          {app.modules.acquisition ? <p>
            {unknown ? '部分专辑成本待补，利润稍后自动补齐。'
              : net === null ? '' : `买入成本 ${yuan(csum)} · 预估利润 `}
            {unknown || net === null ? null
              : <span className={Number(net) - csum < 0 ? 'negative' : 'positive'}>
                  {yuan(Number((net - csum).toFixed(2)))}
                </span>}
            {rs.length > 1 ? ' · 多张按张数均摊' : ''}
          </p> : null}
          <p>买家签收、钱款到账后点「确认收货」转为已售出。</p>
        </div>
        <details className="adv">
          <summary>更多信息</summary>
          <div className="form-grid">
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
