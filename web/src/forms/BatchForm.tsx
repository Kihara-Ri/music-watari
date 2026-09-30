// 批量录入：同一次购买只填一遍日期 / 渠道 / 币种，每行一张专辑（支持照片）。
// 每行照片是普通状态，压缩经同一个串行队列（多张 HEIC 不同时解码）。
import {useRef, useState} from 'react';
import {api} from '../core/api';
import {fmt, fmtJPY, today} from '../core/format';
import {isPending, PhotoQueue, PhotoSlot} from '../core/photos';
import {prefs} from '../core/prefs';
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import type {Currency} from '../types';
import {Seg} from '../components/ui/Seg';
import {ShopField} from '../components/ShopField';
import {CamIco} from '../components/icons';
import {Field} from './fields';
import {PhotoThumbs} from './PhotoSlots';
import {useFormSubmit} from './shared';

interface BatchRow {
  title: string; artist: string; price: string; version: string; photos: PhotoSlot[];
}

const makeRow = (): BatchRow => ({title: '', artist: '', price: '', version: '', photos: []});

export function openBatchForm(app: AppCtx) {
  app.openDrawer({title: '批量录入', asForm: true, wide: true, content: <BatchForm/>});
}

export function BatchForm() {
  const app = useApp();
  const {error, saving, run, setError} = useFormSubmit();
  const [date, setDate] = useState(today());
  const [currency, setCurrency] = useState<Currency>((prefs.get('currency', 'JPY') as Currency) || 'JPY');
  const [location, setLocation] = useState(prefs.get('location', ''));
  const [rows, setRows] = useState<BatchRow[]>([makeRow(), makeRow()]);
  const queue = useRef(new PhotoQueue());
  const fileInput = useRef<HTMLInputElement>(null);
  const photoTarget = useRef(-1);
  const dirty = () => app.setDrawerDirty(true);

  const setRow = (i: number, patch: Partial<BatchRow>) =>
    setRows(prev => prev.map((r, k) => (k === i ? {...r, ...patch} : r)));

  const addRowPhotos = (i: number, files: File[]) => {
    const room = Math.max(9 - rows[i].photos.length, 0);
    if (files.length > room) app.toast(`一次最多再加 ${room} 张`, 'warn');
    const picks = files.slice(0, room);
    if (!picks.length) return;
    const start = rows[i].photos.length;
    setRow(i, {photos: [...rows[i].photos, ...picks.map(() => ({pending: true} as PhotoSlot))]});
    picks.forEach((file, k) => {
      const idx = start + k;
      const patch = (slot: PhotoSlot) => setRows(prev => prev.map((r, ri) =>
        ri !== i ? r : {...r, photos: r.photos.map((p, pi) => (pi === idx && 'pending' in p ? slot : p))}));
      queue.current.add(file, data => patch({data}), msg => patch({error: msg}));
    });
  };

  const removeRowPhoto = (i: number, pi: number) =>
    setRows(prev => prev.map((r, ri) => (ri !== i ? r : {...r, photos: r.photos.filter((_, k) => k !== pi)})));

  const total = rows.reduce((n, row) => n + Number(row.price || 0), 0);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (rows.some(r => r.photos.some(isPending))) {
      setError('还有照片在处理中，等缩略图就绪后再保存');
      return;
    }
    run(app, async () => {
      const items = rows.map(r => ({
        title: r.title, artist: r.artist, price: r.price, version: r.version,
        photos: r.photos.filter(p => !('error' in p)).map(p => (p as {data: string}).data),
        date, currency, location, fees: '0',
      }));
      prefs.set('location', location);
      prefs.set('currency', currency);
      await api('records', {items});
    });
  };

  return (
    <form id="batch-form" onSubmit={submit}>
      <div className="drawer-body">
        <div className="error" role="alert">{error}</div>
        <div className="form-grid">
          <Field label="买入日期" name="batch-date" type="date" required value={date}
                 onChange={e => { setDate(e.target.value); dirty(); }}/>
          <div className="field">
            <span className="field-label"><label>币种</label></span>
            <Seg ariaLabel="币种"
                 options={[{value: 'JPY', label: '日元'}, {value: 'CNY', label: '人民币'}]}
                 value={currency} onValue={c => { setCurrency(c as Currency); dirty(); }}/>
          </div>
          <ShopField value={location} records={app.state.records} defaultShop={prefs.get('location', '')}
                     onChange={v => { setLocation(v); dirty(); }}/>
        </div>
        <div className="batch-heading">专辑名 / 艺人 / 金额 / 碟盒 / 照片</div>
        <input ref={fileInput} type="file" accept="image/*,.heic,.heif" multiple hidden
               onChange={e => {
                 const files = [...(e.target.files ?? [])];
                 e.target.value = '';
                 if (photoTarget.current >= 0) addRowPhotos(photoTarget.current, files);
               }}/>
        <div id="batch-rows">
          {rows.map((row, i) => (
            <div className="batch-item" key={i}>
              <div className="batch-row">
                <input name="batchTitle" aria-label="专辑名" placeholder="专辑名" required
                       value={row.title} onChange={e => { setRow(i, {title: e.target.value}); dirty(); }}/>
                <input name="batchArtist" aria-label="艺人" placeholder="艺人" required
                       value={row.artist} onChange={e => { setRow(i, {artist: e.target.value}); dirty(); }}/>
                <input name="batchPrice" aria-label="金额" placeholder="金额" type="number" min="0"
                       step="0.01" required value={row.price}
                       onChange={e => { setRow(i, {price: e.target.value}); dirty(); }}/>
                <input name="batchVersion" aria-label="碟盒" placeholder="碟盒" autoComplete="off"
                       value={row.version} onChange={e => { setRow(i, {version: e.target.value}); dirty(); }}/>
                <button type="button" className="batch-photo-btn" aria-label="添加实物照片"
                        title="添加实物照片"
                        onClick={() => { photoTarget.current = i; fileInput.current?.click(); }}>
                  {CamIco}<b className="cnt">{row.photos.length || ''}</b>
                </button>
                <button type="button" aria-label="移除这一行"
                        onClick={() => {
                          if (rows.length > 1) setRows(prev => prev.filter((_, k) => k !== i));
                        }}>×</button>
              </div>
              <PhotoThumbs slots={row.photos} recordId={null} small
                           onRemove={pi => { removeRowPhoto(i, pi); dirty(); }}/>
            </div>
          ))}
        </div>
        <button type="button" className="quiet"
                onClick={() => { setRows(prev => [...prev, makeRow()]); dirty(); }}>＋ 再加一张</button>
        <div className="cost-line" id="batch-preview">
          <b>{rows.length} 张 · 合计 {currency === 'JPY' ? fmtJPY(total) : fmt(total)} {currency === 'JPY' ? '円' : '元'}</b>
          {' '}· 保存后进「{currency === 'JPY' ? '海外库存' : '国内库存'}」
        </div>
      </div>
      <div className="drawer-footer">
        <button type="button" onClick={() => app.closeDrawer()}>取消</button>
        <button type="submit" className="primary" disabled={saving}>保存这一批</button>
      </div>
    </form>
  );
}
