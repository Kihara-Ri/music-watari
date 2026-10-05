// 销售单费用编辑：售出中与已交易共用，始终按原售出币种填写。
import {useState} from 'react';
import {api} from '../core/api';
import {shipFeeText, sum, yuan} from '../core/format';
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import type {Sale} from '../types';
import {Field} from './fields';
import {AlbumLine} from '../components/SaleCard';
import {useFormSubmit, useRate} from './shared';

export function openSaleCostsForm(app: AppCtx, sale: Sale) {
  app.openDrawer({title: '修改销售费用', asForm: true, content: <SaleCostsForm sale={sale}/>});
}

function SaleCostsForm({sale}: {sale: Sale}) {
  const app = useApp();
  const {error, saving, run} = useFormSubmit();
  const jpy = sale.currency === 'JPY';
  // 日元费用只接受整数：库里存的是两位小数格式（108.00），编辑界面取整回显，
  // 输入时过滤掉小数点（与买入金额切日元取整同一口径）
  const intStr = (v: string | null | undefined) =>
    v == null || v === '' ? '' : String(Math.round(Number(v)));
  const [fees, setFees] = useState(jpy ? intStr(sale.feesOriginal) : sale.fees);
  const [postage, setPostage] = useState(jpy ? intStr(sale.postageOriginal) : sale.postage || '0');
  const rate = useRate(sale.date);
  const rs = sale.items.map(i => app.rec(i.recordId)).filter(r => !!r);
  const unknown = sale.items.some(i => i.profit === null);
  const convert = (value: string, original: string | undefined, cny: string) => {
    if (value === '') return null;
    if (Number(value) === Number(jpy ? original : cny)) return Number(cny);
    return jpy ? rate === null ? null : Number(value) * rate / 100 : Number(value);
  };
  const fc = convert(fees, sale.feesOriginal, sale.fees);
  const pc = convert(postage, sale.postageOriginal, sale.postage || '0');
  const net = fc === null || pc === null ? null : Number(sale.gross) - fc - pc;
  const shipping = sale.status === 'shipping';
  const unit = jpy ? '日元' : '元';
  const step = jpy ? 'any' : '0.01';
  const inputMode = jpy ? 'numeric' as const : 'decimal' as const;
  const onFeeInput = (set: (v: string) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    set(jpy ? e.target.value.replace(/[^\d]/g, '') : e.target.value);
    app.setDrawerDirty(true);
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(app, () => api('sale-update', {id: sale.id, fees, postage}), '销售费用已更新');
  };
  return <form onSubmit={submit}>
    <div className="drawer-body">
      <div className="error" role="alert">{error}</div>
      {rs.map(r => <AlbumLine key={r.id} r={r} showCost={app.modules.acquisition}/>)}
      <p className="small-note">{sale.date} 售出 · {sale.channel} · 成交价 {shipFeeText(sale.currency, sale.grossOriginal, sale.gross)}</p>
      <div className="form-grid form-section">
        <Field label={`平台扣费合计（${unit}）`} name="sale-fees" type="number" required min="0" step={step}
          inputMode={inputMode} value={fees} onChange={onFeeInput(setFees)}/>
        <Field label={`寄出运费（${unit}）`} name="sale-postage" type="number" required min="0" step={step}
          inputMode={inputMode} value={postage} onChange={onFeeInput(setPostage)}/>
      </div>
      <p className="small-note">平台有多项服务费时填写合计；确认收货后仍可补录、修改。</p>
      {jpy ? <p className="small-note">按售出日汇率折算人民币。</p> : null}
      <div className="preview sale-preview">
        <div className="line"><b>{yuan(net)}</b><span>{shipping ? '预计到手' : '到手'}</span>
          {app.modules.acquisition && net !== null && !unknown ? <>
            <span className="hint">· {shipping ? '预估利润' : '利润'}</span>
            <span>{yuan(net - sum(rs, 'cost'))}</span>
          </> : null}
          {app.modules.acquisition && unknown ? <span className="hint">· 成本待补</span> : null}
        </div>
        {net === null && jpy && fees !== '' && postage !== '' ? <p>暂无售出日汇率，无法预览折算金额。</p> : null}
        {rs.length > 1 ? <p>费用按张数均摊，到手与利润自动更新。</p> : null}
      </div>
    </div>
    <div className="drawer-footer">
      <button type="button" onClick={() => app.closeDrawer()}>取消</button>
      <button type="submit" className="primary" disabled={saving}>保存费用</button>
    </div>
  </form>;
}
