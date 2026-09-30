// 库存页（海外 / 国内 / 回收站共用）：搜索、排序、时间线/艺人分组、批量操作条。
import {useApp} from '../state/AppContext';
import type {AlbumRecord, SortMode} from '../types';
import {fmtMonth, sum, yuan} from '../core/format';
import {searchScore} from '../core/search';
import {PageHead} from '../components/PageHead';
import {AlbumCard, CardGrid} from '../components/Cards';
import {Dropdown} from '../components/ui/Dropdown';
import {openRecordForm} from '../forms/RecordForm';
import {openSaleForm} from '../forms/SaleForm';
import {openShipForm} from '../forms/ShipForm';
import {openBatchForm} from '../forms/BatchForm';
import {openDetail} from '../forms/DetailDrawer';
import {bulkAction} from '../forms/shared';

const SORTS = [
  {value: 'new', label: '最近买入'},
  {value: 'cost', label: '成本从高到低'},
  {value: 'artist', label: '按艺人'},
];

const LISTED_FILTERS = [
  {value: 'all', label: '全部专辑'},
  {value: 'listed', label: '已上架'},
  {value: 'unlisted', label: '未上架'},
];

function shelfRecords(records: AlbumRecord[], page: string, query: string, sort: SortMode, listedFilter: string): AlbumRecord[] {
  let rs = records.filter(r => r.status === page);
  if (page !== 'trash' && listedFilter !== 'all')
    rs = rs.filter(r => listedFilter === 'listed' ? !!r.listed : !r.listed);
  const q = query.trim().toLocaleLowerCase();
  if (q) {
    rs = rs.map(r => ({r, sc: searchScore(r, q)})).filter(x => x.sc > 0)
      .sort((a, b) => b.sc - a.sc).map(x => x.r);
  } else {
    rs.sort((a, b) => sort === 'cost'
      ? ((b.cost === null ? -1 : Number(b.cost)) - (a.cost === null ? -1 : Number(a.cost)))
      : sort === 'artist' ? a.artist.localeCompare(b.artist)
        : b.date.localeCompare(a.date));
  }
  return rs;
}

export function ShelfPage() {
  const app = useApp();
  const {state, page, query, sort, flip, selected, shelfFilter} = app;
  const isTrash = page === 'trash';
  const rymLinks = state.settings['rym-links'] as Record<string, string> | undefined;
  const all = state.records.filter(r => r.status === page);
  const known = all.filter(r => r.cost !== null);
  const listedCount = all.filter(r => r.listed).length;
  const rs = shelfRecords(state.records, page, query, sort, shelfFilter);
  const searching = query.trim() !== '';

  // 选择集只在当前可见结果内生效
  const visible = new Set(rs.map(r => r.id));
  const curSelected = new Set([...selected].filter(id => visible.has(id)));
  const toggleSelect = (id: string, on: boolean) => {
    const next = new Set(app.selected);
    if (on) next.add(id); else next.delete(id);
    app.setSelected(next);
  };

  const title = page === 'overseas' ? '海外库存' : page === 'domestic' ? '国内库存' : '回收站';
  const desc = page === 'overseas' ? '在日本持有的专辑，可标记上架（如メルカリ）或直接记录售出；选中多张可打包运输。'
    : page === 'domestic' ? '已运回国；标记「已上架」的正在闲鱼出售，其余暂未上架，随时可记录售出。'
      : '移除的专辑保留在这里，随时可以恢复。';

  const cardActions = (r: AlbumRecord) => {
    if (page === 'trash') return <button onClick={() => bulkAction(app, 'restore', [r.id])}>恢复</button>;
    return (
      <>
        <button className="primary" onClick={() => openSaleForm(app, [r.id])}>记录售出</button>
        <button onClick={() => openRecordForm(app, r.id)}>编辑</button>
      </>
    );
  };

  const renderCard = (r: AlbumRecord) => (
    <AlbumCard key={r.id} r={r} page={page} checked={curSelected.has(r.id)}
               onSelect={isTrash ? undefined : toggleSelect}
               onDetail={id => openDetail(app, id)}
               actions={cardActions(r)}/>
  );

  let body: React.ReactNode;
  if (!rs.length) {
    body = (
      <div className="empty">
        <div className="empty-symbol">{isTrash ? '◎' : '◫'}</div>
        <h3>{query ? '没有找到匹配的专辑' : page === 'overseas' ? '海外库存是空的' : isTrash ? '回收站是空的' : '库存是空的'}</h3>
        <p>{query ? '试试其他关键词。'
          : page === 'overseas' ? '录入在海外买入的专辑，或把国内库存调回海外。'
            : isTrash ? '移除的专辑会出现在这里。'
              : '记录一次买入，封面会自动从公开音乐资料库抓取。'}</p>
        {query
          ? <button onClick={() => app.setQuery('')}>清除搜索</button>
          : !isTrash ? <button className="primary" onClick={() => openRecordForm(app)}>＋ 添加专辑</button> : null}
      </div>
    );
  } else if (!searching && sort === 'new') {
    // 按月时间线
    const sorted = [...rs].sort((a, b) => flip
      ? (a.date || '9999').localeCompare(b.date || '9999')
      : (b.date || '').localeCompare(a.date || ''));
    const groups = new Map<string, AlbumRecord[]>();
    for (const r of sorted) {
      const k = r.date ? r.date.slice(0, 7) : '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push(r);
    }
    body = [...groups.entries()].map(([m, list]) => (
      <section className="tl-group" key={m}>
        <div className="tl-label"><b>{fmtMonth(m)}</b><span>{list.length} 张</span></div>
        <div className="tl-rail"/>
        <div className="tl-cards"><CardGrid records={list} renderCard={renderCard}/></div>
      </section>
    ));
  } else if (!searching && sort === 'artist') {
    // 按艺人分组
    const map = new Map<string, AlbumRecord[]>();
    for (const r of [...rs].sort((a, b) => (b.date || '').localeCompare(a.date || ''))) {
      const a = r.artist || '未知艺人';
      if (!map.has(a)) map.set(a, []);
      map.get(a)!.push(r);
    }
    body = [...map.keys()].sort((a, b) => a.localeCompare(b)).map(a => {
      const list = map.get(a)!;
      const knownList = list.filter(r => r.cost !== null);
      const total = knownList.length ? yuan(sum(knownList, 'cost')) : null;
      const rymLink = rymLinks?.[a];
      return (
        <section className="artist-group" key={a}>
          <header className="artist-head">
            <a className="artist-name" href={rymLink ?? `https://rateyourmusic.com/search?searchterm=${encodeURIComponent(a)}&searchtype=a`}
               target="_blank" rel="noopener"
               title={rymLink ? '已绑定 · 打开 RateYourMusic 艺人页'
                              : '打开 RateYourMusic 搜索；选中艺人后可用设置页的绑定书签一键记住直达链接'}>
              {a}<span className="ext" aria-hidden="true">↗</span>
            </a>
            <span className="artist-meta">
              {list.length} 张{total ? ` · 总成本 ${total}` : ''}
              {knownList.length < list.length ? ` · ${list.length - knownList.length} 张成本待补` : ''}
            </span>
          </header>
          <CardGrid records={list} renderCard={renderCard}/>
        </section>
      );
    });
  } else {
    body = <CardGrid records={rs} renderCard={renderCard}/>;
  }

  return (
    <>
      <PageHead title={title} desc={desc} label="COLLECTION" actions={isTrash ? null : (
        <>
          <button onClick={() => openBatchForm(app)}>批量录入</button>
          <button className="primary" onClick={() => openRecordForm(app)}>＋ 添加专辑</button>
        </>
      )}/>
      <div className="summary">
        <span><strong>{all.length}</strong> 张专辑</span>
        {!isTrash && (
          <>
            <span>总成本 <strong>{known.length ? yuan(sum(known, 'cost')) : '—'}</strong></span>
            {all.length - known.length ? <span className="hint">· {all.length - known.length} 张成本待补</span> : null}
            {!isTrash ? <span className="hint">· 已上架 {listedCount} 张</span> : null}
            {page === 'overseas' ? <span className="hint">✈ 勾选多张可打包为一趟运输</span> : null}
          </>
        )}
      </div>
      <div className="toolbar">
        {!isTrash && (
          <label className="select-all" title="全选当前结果">
            <input type="checkbox" aria-label="全选当前结果"
                   checked={!!curSelected.size && curSelected.size === rs.length}
                   onChange={e => app.setSelected(e.target.checked ? new Set(rs.map(r => r.id)) : new Set())}/>
            全选
          </label>
        )}
        <div className="search">
          <input aria-label="搜索专辑" placeholder="搜索专辑、艺人或渠道…" value={query}
                 onChange={e => app.setQuery(e.target.value)}/>
        </div>
        {sort === 'new' && !searching ? (
          <button className={`flip-btn${flip ? ' on' : ''}`} aria-label="倒转时间顺序"
                  title="倒转时间顺序（新↔旧）"
                  onClick={() => app.setFlip(!flip)}>⇅</button>
        ) : null}
        {!isTrash ? (
          <Dropdown id="listed" value={shelfFilter} options={LISTED_FILTERS} label="上架筛选"
                    onPick={v => app.setShelfFilter(v)}/>
        ) : null}
        <Dropdown id="sort" value={sort} options={SORTS} label="排序方式"
                  onPick={v => app.setSort(v as SortMode)}/>
      </div>
      {curSelected.size ? (
        <div className="bulkbar">
          <strong>已选 {curSelected.size} 张</strong>
          {page === 'overseas' ? (
            <>
              <button className="primary" onClick={() => openShipForm(app, [...curSelected])}>✈ 打包运输</button>
              <button onClick={() => bulkAction(app, 'list', [...curSelected], '已标记上架')}>标记上架</button>
              <button onClick={() => bulkAction(app, 'unlist', [...curSelected], '已取消上架')}>取消上架</button>
            </>
          ) : null}
          {page === 'domestic' ? (
            <>
              <button className="primary" onClick={() => openSaleForm(app, [...curSelected])}>合单售出</button>
              <button onClick={() => bulkAction(app, 'list', [...curSelected], '已标记上架')}>标记上架</button>
              <button onClick={() => bulkAction(app, 'unlist', [...curSelected], '已取消上架')}>取消上架</button>
              <button onClick={() => bulkAction(app, 'to_overseas', [...curSelected])}>调回海外</button>
            </>
          ) : null}
          {!isTrash
            ? <button onClick={() => bulkAction(app, 'delete', [...curSelected], '已移入回收站，可在设置中恢复')}>移入回收站</button>
            : <button onClick={() => bulkAction(app, 'restore', [...curSelected])}>恢复专辑</button>}
          <button className="quiet" onClick={() => app.setSelected(new Set())}>取消</button>
        </div>
      ) : null}
      {body}
    </>
  );
}
