// 确认表单族：签收 / 回滚 / 撤销运输 / 确认收货 / 撤销售出 / 退款退货 / 恢复备份。
// 原版 simpleForm 的每一种 kind，提交时路由到对应 API。
import {useState} from 'react';
import {api} from '../core/api';
import {today} from '../core/format';
import {useApp} from '../state/AppContext';
import type {BackupFile, Sale} from '../types';
import {Field} from './fields';
import {useFormSubmit} from './shared';

export type ConfirmKind = 'arrive' | 'undo_arrive' | 'cancel_shipment' | 'receive' | 'cancel' | 'refund' | 'restore';

export const CONFIRM_TITLES: Record<ConfirmKind, string> = {
  arrive: '确认签收',
  undo_arrive: '回滚签收',
  cancel_shipment: '撤销运输',
  receive: '确认收货',
  cancel: '撤销售出',
  refund: '退款 / 退货',
  restore: '恢复完整备份',
};

export function ConfirmForm({kind, id, arriveCount, sale, restoreData}: {
  kind: ConfirmKind;
  id?: string;
  arriveCount?: number;
  sale?: Sale;
  restoreData?: BackupFile;
}) {
  const app = useApp();
  const {error, saving, run} = useFormSubmit();
  const [date, setDate] = useState(today());
  const [refund, setRefund] = useState(sale ? sale.gross : '');
  const [returned, setReturned] = useState(false);
  const [ack, setAck] = useState(false);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    run(app, async () => {
      if (kind === 'restore') return api('restore', restoreData);
      if (kind === 'arrive') return api('shipment-action', {id, action: 'arrive', date});
      if (kind === 'undo_arrive') return api('shipment-action', {id, action: 'undo_arrive'});
      if (kind === 'cancel_shipment') return api('shipment-action', {id, action: 'cancel'});
      return api('sale-action', {id, action: kind, ...(kind === 'refund' ? {refund} : {}), date, returned});
    });
  };

  return (
    <form id="simple-form" onSubmit={submit}>
      <div className="drawer-body">
        <div className="error" role="alert">{error}</div>
        {kind === 'arrive' && (
          <>
            <p>整包 {arriveCount ?? ''} 张专辑转入国内库存。</p>
            <div className="form-grid form-section">
              <Field label="签收日期" name="arrive-date" type="date" required value={date} onChange={e => setDate(e.target.value)}/>
            </div>
            <p className="small-note">误操作可在「最近签收」里回滚。</p>
          </>
        )}
        {kind === 'undo_arrive' && <p>这批专辑将退回「海外在途」，签收日期清空。</p>}
        {kind === 'cancel_shipment' && <p>包裹取消，专辑退回「海外库存」，运费分摊从成本中扣回。</p>}
        {kind === 'receive' && (
          <>
            <p>买家已签收、钱款已到账。交易转为「已售出」，{app.modules.acquisition ? '利润' : '到账金额'}计入统计。平台扣费和寄出运费仍可修改，此后不再支持退款操作。</p>
            <div className="form-grid form-section">
              <Field label="到账日期" name="receive-date" type="date" required value={date} onChange={e => setDate(e.target.value)}/>
            </div>
          </>
        )}
        {kind === 'cancel' && <p>用于纠正误记或未成交，专辑回到原状态，交易保留撤销历史。</p>}
        {kind === 'refund' && (
          <>
            <p className="help">仅限「售出中」的交易；销售费用保留为损失；勾选退货则专辑回到{app.modules.circulation ? '国内库存' : '我的收藏'}。</p>
            <div className="form-grid form-section">
              <Field label="退款总额（元）" name="refund" type="number" required min="0"
                     max={sale?.gross} step="0.01" value={refund} onChange={e => setRefund(e.target.value)}/>
              <Field label="处理日期" name="refund-date" type="date" required value={date} onChange={e => setDate(e.target.value)}/>
            </div>
            <label className="check-line">
              <input name="returned" type="checkbox" checked={returned} onChange={e => setReturned(e.target.checked)}/>
              已收到退回专辑，恢复库存
            </label>
          </>
        )}
        {kind === 'restore' && (
          <>
            <p>将替换当前数据：备份中有 <strong>{restoreData?.records.length}</strong> 张专辑、
              <strong>{restoreData?.shipments?.length ?? 0}</strong> 个包裹和
              <strong>{restoreData?.sales.length}</strong> 笔交易。</p>
            <p className="small-note">备份日期：{restoreData?.createdAt}。恢复前会自动备份当前数据。</p>
            <label className="check-line">
              <input type="checkbox" required checked={ack} onChange={e => setAck(e.target.checked)}/>
              我确认用此备份替换当前数据
            </label>
          </>
        )}
      </div>
      <div className="drawer-footer">
        <button type="button" onClick={() => app.closeDrawer()}>取消</button>
        <button type="submit" className="primary" disabled={saving}>确认</button>
      </div>
    </form>
  );
}
