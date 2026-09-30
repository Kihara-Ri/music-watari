// 表单共享：提交流程（禁用按钮 → API → 关抽屉 → 刷新 → toast → 错误就地显示）、
// 汇率获取与批量操作 helper。
import {useEffect, useState} from 'react';
import {api} from '../core/api';
import {today} from '../core/format';
import type {AppCtx} from '../state/AppContext';

// 当日汇率（每 100 円兑人民币）；无数据返回 null，由调用方提示「暂无当日汇率」。
export function useRate(date: string) {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api<{rate: number | null}>('rate?date=' + (date || today()))
      .then(res => { if (!cancelled) setRate(res.rate); })
      .catch(() => { if (!cancelled) setRate(null); });
    return () => { cancelled = true; };
  }, [date]);
  return rate;
}

export function useFormSubmit() {
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const run = async (app: AppCtx, fn: () => Promise<unknown>, successMsg = '已保存') => {
    setSaving(true); setError('');
    try {
      await fn();
      app.closeDrawer(true);
      app.setSelected(new Set());
      await app.refresh();
      app.toast(successMsg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  return {error, saving, run, setError};
}

export async function bulkAction(app: AppCtx, action: string, ids: string[], successMsg = '已更新') {
  try {
    await api('bulk', {action, ids});
  } catch (e) {
    app.toast(e instanceof Error ? e.message : String(e), 'err');
    return;
  }
  app.setSelected(new Set());
  app.closeDrawer(true);
  await app.refresh();
  app.toast(successMsg);
}
