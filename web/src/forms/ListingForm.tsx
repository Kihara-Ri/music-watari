import {useState} from 'react';
import {api} from '../core/api';
import {useApp} from '../state/AppContext';
import type {AppCtx} from '../state/AppContext';
import {Field} from './fields';
import {useFormSubmit} from './shared';

export function openListingForm(app: AppCtx, id: string) {
  app.openDrawer({title: '上架资料', asForm: true, content: <ListingForm id={id}/>});
}

function ListingForm({id}: {id: string}) {
  const app = useApp();
  const r = app.rec(id);
  const [channel, setChannel] = useState(r?.listingChannel || '');
  const [url, setUrl] = useState(r?.listingUrl || '');
  const {error, saving, run} = useFormSubmit();
  return <form onSubmit={e => {
    e.preventDefault();
    run(app, async () => { await api('bulk', {action: 'list', ids: [id], listing: {channel, url}}); });
  }}>
    <div className="drawer-body">
      <p className="help">保存商品所在的平台和链接，方便从收藏回到发布页面。</p>
      <div className="error" role="alert">{error}</div>
      <div className="form-grid">
        <Field label="上架平台（选填）" name="listing-channel" value={channel} maxLength={100}
          placeholder="例如：闲鱼、Discogs、メルカリ" onChange={e => { setChannel(e.target.value); app.setDrawerDirty(true); }}/>
        <Field label="商品链接（选填）" name="listing-url" type="url" value={url} maxLength={2000}
          placeholder="https://…" onChange={e => { setUrl(e.target.value); app.setDrawerDirty(true); }}/>
      </div>
    </div>
    <div className="drawer-footer">
      <button type="button" onClick={() => app.closeDrawer()}>取消</button>
      <button type="submit" className="primary" disabled={saving}>保存并标记上架</button>
    </div>
  </form>;
}
