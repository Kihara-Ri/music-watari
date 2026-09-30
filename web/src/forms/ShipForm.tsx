// 打包运输表单（海外库存多选）与包裹编辑表单（改运费自动重算分摊）。
// 运输方式=日本邮政个人国际邮件全方案；运费复用「买入金额」的币种金额组，
// 日元按发货日汇率折算人民币后均摊（服务端折算，见 storage.to_cny）。
import {useEffect, useRef, useState} from 'react';
import {api} from '../core/api';
import {today, yuan} from '../core/format';
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import type {Currency} from '../types';
import {Field, MoneyField, TextareaField} from './fields';
import {Dropdown} from '../components/ui/Dropdown';
import {AlbumLine} from '../components/SaleCard';
import {useFormSubmit, useRate} from './shared';

// 日本邮政个人国际邮件全方案（官网服务一览，按速度从快到慢）：
// EMS / 国际航空信函 / 小型包装物（航空·SAL·船运）/ 国际小包（航空·SAL·船运）。
// SAL 经济航空现全面停运，标注保留备查。
const JP_METHODS: {value: string; label: string}[] = [
  {value: 'EMS', label: 'EMS'},
  {value: '国际航空信函', label: '国际航空信函（エアパケット）'},
  {value: '小型包装物 · 航空', label: '小型包装物 · 航空'},
  {value: '小型包装物 · SAL', label: '小型包装物 · SAL（停运）'},
  {value: '小型包装物 · 船运', label: '小型包装物 · 船运'},
  {value: '国际小包 · 航空', label: '国际小包 · 航空'},
  {value: '国际小包 · SAL', label: '国际小包 · SAL（停运）'},
  {value: '国际小包 · 船运', label: '国际小包 · 船运'},
];

// 历史运单可能是列表外的旧值（如「国际小包」「航空件」），编辑时追加为可选项保留显示
const methodOptions = (cur: string) => {
  const os = JP_METHODS.slice();
  if (cur && !os.some(o => o.value === cur)) os.push({value: cur, label: cur});
  return os;
};

export function openShipForm(app: AppCtx, ids: string[]) {
  app.openDrawer({title: '打包运输', asForm: true, content: <ShipForm ids={ids}/>});
}

// 日元运费的折算提示行（与买入金额的「折合成本」口径一致）
const costLineText = (currency: Currency, cost: string, rate: number | null, cny: number | null) => {
  if (currency !== 'JPY') return '';
  let text = `折合成本 ${cost === '' ? '—' : cny === null ? '待定' : yuan(Number(cny.toFixed(2)))}`;
  if (cost !== '' && cny === null) text += ' · 暂无当日汇率';
  if (rate !== null) text += ` · 100 円 = ¥${Number(rate).toFixed(2)}`;
  return text;
};

function ShipForm({ids}: {ids: string[]}) {
  const app = useApp();
  const {error, saving, run} = useFormSubmit();
  const [v, setV] = useState({method: JP_METHODS[0].value, date: today(), currency: 'CNY' as Currency, cost: '', note: ''});
  const set = (patch: Partial<typeof v>) => { setV(prev => ({...prev, ...patch})); app.setDrawerDirty(true); };
  const rs = ids.map(app.rec).filter((r): r is NonNullable<typeof r> => !!r);
  const rate = useRate(v.date);
  const cny = v.cost === '' ? null : v.currency === 'CNY' ? Number(v.cost)
    : rate === null ? null : Number(v.cost) * rate / 100;
  const cnyQ = cny === null ? null : Number(cny.toFixed(2));
  const share = cnyQ === null ? null : cnyQ / rs.length;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(app, () => api('shipments', {...v, ids}));
  };

  return (
    <form id="ship-form" onSubmit={submit}>
      <div className="drawer-body">
        <div className="error" role="alert">{error}</div>
        <p className="help">这 {rs.length} 张专辑打包为一趟运输，状态变为「海外在途」，约 11 天后签收。</p>
        {rs.map(r => <AlbumLine key={r.id} r={r} showCost={false}/>)}
        <div className="field form-section">
          <span className="field-label"><label>运输方式</label></span>
          <Dropdown id="ship-method" label="运输方式" value={v.method}
                    options={methodOptions(v.method)} onPick={m => set({method: m})}/>
        </div>
        <section className="money-block form-section">
          <div className="money-row">
            <MoneyField label="运费" name="ship-cost" currency={v.currency} value={v.cost}
                        onCurrency={(c, val) => set({currency: c, cost: val})}
                        onChange={val => set({cost: val})}/>
            <Field label="发货日期" name="ship-date" type="date" required value={v.date}
                   onChange={e => set({date: e.target.value})}/>
          </div>
          {v.currency === 'JPY' && <div className="cost-line">{costLineText(v.currency, v.cost, rate, cny)}</div>}
        </section>
        <TextareaField label="备注" name="ship-note" value={v.note} onChange={val => set({note: val})}/>
        <div className="preview">
          <strong>{rs.length} 张 · 运费 {cnyQ === null ? '—' : yuan(cnyQ)}</strong>
          <p>{share === null || share === 0 ? '未填运费则不增加成本。'
            : `运费均摊到每张成本：+${yuan(Number(share.toFixed(2)))}，签收前可撤销或修改。`}</p>
        </div>
      </div>
      <div className="drawer-footer">
        <button type="button" onClick={() => app.closeDrawer()}>取消</button>
        <button type="submit" className="primary" disabled={saving}>创建运输</button>
      </div>
    </form>
  );
}

export function openShipmentEdit(app: AppCtx, id: string) {
  app.openDrawer({title: '编辑包裹', asForm: true, content: <ShipmentEditForm id={id}/>});
}

function ShipmentEditForm({id}: {id: string}) {
  const app = useApp();
  const s = app.state.shipments.find(x => x.id === id);
  const {error, saving, run} = useFormSubmit();
  const [v, setV] = useState(() => s ? {
      method: s.method, date: s.date,
      currency: (s.currency || 'CNY') as Currency,
      cost: s.currency === 'JPY' && s.costOriginal ? String(Math.round(Number(s.costOriginal))) : s.cost,
      note: s.note,
    }
    : {method: '', date: '', currency: 'CNY' as Currency, cost: '', note: ''});
  const set = (patch: Partial<typeof v>) => { setV(prev => ({...prev, ...patch})); app.setDrawerDirty(true); };
  // 与打开时快照比对：没改动或改回原值时按钮置灰
  const pristine = useRef(JSON.stringify(v));
  const edited = JSON.stringify(v) !== pristine.current;
  useEffect(() => { app.setDrawerDirty(edited); }, [edited]);
  const rate = useRate(v.date);
  const cny = v.cost === '' ? null : v.currency === 'CNY' ? Number(v.cost)
    : rate === null ? null : Number(v.cost) * rate / 100;
  if (!s) return null;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(app, () => api('shipment-update', {...v, id}));
  };

  return (
    <form id="ship-edit-form" onSubmit={submit}>
      <div className="drawer-body">
        <div className="error" role="alert">{error}</div>
        <div className="field">
          <span className="field-label"><label>运输方式</label></span>
          <Dropdown id="edit-method" label="运输方式" value={v.method}
                    options={methodOptions(v.method)} onPick={m => set({method: m})}/>
        </div>
        <section className="money-block form-section">
          <div className="money-row">
            <MoneyField label="运费" name="edit-cost" currency={v.currency} value={v.cost}
                        onCurrency={(c, val) => set({currency: c, cost: val})}
                        onChange={val => set({cost: val})}/>
            <Field label="发货日期" name="edit-date" type="date" required value={v.date}
                   onChange={e => set({date: e.target.value})}/>
          </div>
          {v.currency === 'JPY' && <div className="cost-line">{costLineText(v.currency, v.cost, rate, cny)}</div>}
        </section>
        <TextareaField label="备注" name="edit-note" value={v.note} onChange={val => set({note: val})}/>
        <p className="small-note">
          修改运费会自动调整每张专辑的成本分摊（当前每张 {yuan(Number((Number(s.cost) / s.items.length).toFixed(2)))}）。
        </p>
      </div>
      <div className="drawer-footer">
        <button type="button" onClick={() => app.closeDrawer()}>取消</button>
        <button type="submit" className="primary" disabled={saving || !edited}>保存修改</button>
      </div>
    </form>
  );
}
