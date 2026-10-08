import assert from 'node:assert/strict';
import {after, afterEach, beforeEach, test} from 'node:test';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';

// 编译真实源文件与依赖；产物在临时目录，测试不维护第二份图库实现。
const output = mkdtempSync(join(tmpdir(), 'diedu-gallery-test-'));
let gallery;
try {
  const source = fileURLToPath(new URL('../src/', import.meta.url));
  const program = ts.createProgram([join(source, 'core/gallery.ts')], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true, skipLibCheck: true, types: [], rootDir: source, outDir: output,
  });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.equal(diagnostics.length, 0, ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => source, getCanonicalFileName: name => name, getNewLine: () => '\n',
  }));
  assert.equal(program.emit().emitSkipped, false);
  writeFileSync(join(output, 'package.json'), '{"type":"commonjs"}');
  gallery = createRequire(import.meta.url)(join(output, 'core/gallery.js'));
} catch (error) {
  rmSync(output, {recursive: true, force: true});
  throw error;
}
after(() => rmSync(output, {recursive: true, force: true}));

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
let storage;
beforeEach(() => {
  storage = new Map();
  Object.defineProperty(globalThis, 'localStorage', {configurable: true, value: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, String(value)),
  }});
});
afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
  else delete globalThis.localStorage;
});

function record(id, status = 'domestic', overrides = {}) {
  return {
    id, title: '同一张专辑', artist: '测试艺人', status,
    date: '', currency: 'CNY', price: '', fees: '0.00', actual: '', cost: null,
    cover: '', location: '', version: '', pressing: '', obi: '', note: '', noteAlbum: '',
    photoCount: 0, revision: 1, createdAt: '2026-10-06T00:00:00', ...overrides,
  };
}

test('收藏范围包含国内、海外和在途，排除已成交、已售和回收站', () => {
  const statuses = {domestic: true, overseas: true, transit: true, shipping: false, sold: false, trash: false};
  const records = Object.keys(statuses).map(status => record(status, status));
  for (const r of records) assert.equal(gallery.isCollectedRecord(r), statuses[r.status], r.status);
  assert.deepEqual(gallery.galleryRecords(records, '', 'recent').map(r => r.id).sort(),
    ['domestic', 'overseas', 'transit']);
});

test('上架、缺封面以及同名不同副本均保留独立记录', () => {
  const records = [record('copy-a', 'domestic', {listed: true}), record('copy-b', 'overseas'),
    record('no-cover', 'transit', {title: '没有封面的收藏'})];
  const result = gallery.galleryRecords(records, '', 'recent');
  assert.deepEqual(result.map(r => r.id), ['copy-a', 'copy-b', 'no-cover']);
  assert.equal(result[0].listed, true);
  assert.equal(result[2].cover, '');
  assert.equal(result[0].cost, null);
});

test('筛选排序不修改原副本或数组顺序', () => {
  const records = Object.freeze([
    Object.freeze(record('old', 'domestic', {createdAt: '2026-10-01T00:00:00'})),
    Object.freeze(record('new', 'transit', {createdAt: '2026-10-06T00:00:00'})),
  ]);
  assert.deepEqual(gallery.galleryRecords(records, '', 'recent').map(r => r.id), ['new', 'old']);
  assert.deepEqual(records.map(r => r.id), ['old', 'new']);
  assert.equal(records[0].cost, null);
});

test('旧包含在途偏好不再限制收藏范围', () => {
  storage.set('album-gallery-v1', JSON.stringify({mode: 'tiles', includeTransit: false, currentId: 'travelling'}));
  const preferences = gallery.readGalleryPreferences();
  assert.equal(Object.hasOwn(preferences, 'includeTransit'), false);
  assert.equal(preferences.currentId, 'travelling');
  assert.deepEqual(gallery.galleryRecords([record('travelling', 'transit')], '', preferences.sort).map(r => r.id),
    ['travelling']);
});

test('在途副本可搜索，已成交副本不会被搜索重新纳入', () => {
  const records = [record('travelling', 'transit', {title: '夏日唱片'}),
    record('sold-copy', 'shipping', {title: '夏日唱片'}), record('other', 'domestic', {title: '另一位歌手的现场录音'})];
  assert.deepEqual(gallery.galleryRecords(records, '夏日唱片', 'title').map(r => r.id), ['travelling']);
});

test('九种展示模式的偏好均可保存恢复', () => {
  assert.equal(gallery.GALLERY_MODES.length, 9);
  assert.equal(new Set(gallery.GALLERY_MODES.map(mode => mode.value)).size, 9);
  for (const mode of gallery.GALLERY_MODES) {
    assert.ok(mode.label.trim());
    assert.ok(mode.description.trim());
    const preferences = {mode: mode.value, density: 'large', showTitles: true, sort: 'artist', currentId: 'copy-b', scope: {kind: 'all'}, roamingSpeeds: {}};
    gallery.saveGalleryPreferences(preferences);
    assert.deepEqual(gallery.readGalleryPreferences(), preferences, mode.value);
  }
});

test('当前副本移除后回退到有效起点', () => {
  const records = [record('first'), record('current')];
  assert.equal(gallery.galleryIndex(records, 'current'), 1);
  assert.equal(gallery.galleryIndex(records.slice(0, 1), 'current'), 0);
  assert.equal(gallery.galleryIndex(records, null), 0);
  assert.equal(gallery.galleryIndex([], 'current'), 0);
});

test('每种布局独立恢复漫游速度，旧偏好和非法速度回退，不保存漫游启动状态', () => {
  storage.set('album-gallery-v1', JSON.stringify({mode: 'crate', roaming: true,
    roamingSpeeds: {crate: 3, film: 30, flow: 1, ring: 31, tiles: '8', waterfall: 2.5}}));
  const preferences = gallery.readGalleryPreferences();
  assert.deepEqual(preferences.roamingSpeeds, {film: 30, crate: 3});
  assert.equal(Object.hasOwn(preferences, 'roaming'), false);
  gallery.saveGalleryPreferences({...preferences, roamingSpeeds: {...preferences.roamingSpeeds, fan: 12}});
  assert.deepEqual(gallery.readGalleryPreferences().roamingSpeeds, {film: 30, crate: 3, fan: 12});
  storage.set('album-gallery-v1', JSON.stringify({mode: 'waterfall'}));
  assert.deepEqual(gallery.readGalleryPreferences().roamingSpeeds, {});
});

test('艺人范围精确匹配本地名称，搜索继续限定在该艺人内', () => {
  const records = [record('a', 'domestic', {artist: '歌手 A', title: '夜晚'}),
    record('b', 'transit', {artist: '歌手 A', title: '白天'}),
    record('c', 'domestic', {artist: '歌手 A 与 B', title: '夜晚'}),
    record('d', 'sold', {artist: '歌手 A', title: '夜晚'})];
  const scope = {kind: 'artist', artist: '歌手 A'};
  assert.deepEqual(gallery.galleryRecords(records, '', 'title', scope).map(r => r.id).sort(), ['a', 'b']);
  assert.deepEqual(gallery.galleryRecords(records, '夜晚', 'title', scope).map(r => r.id), ['a']);
});

test('展示组遵守手动顺序并排除不在收藏中的成员，不合并同名副本', () => {
  const records = [record('a'), record('b'), record('sold', 'sold'), record('trash', 'trash')];
  const groups = [{id: 'group-a', name: '夜晚', recordIds: ['b', 'missing', 'sold', 'a', 'trash']}];
  const original = JSON.stringify(groups);
  assert.deepEqual(gallery.galleryRecords(records, '', 'group', {kind: 'group', groupId: 'group-a'}, groups).map(r => r.id), ['b', 'a']);
  assert.equal(JSON.stringify(groups), original);
  assert.deepEqual(gallery.galleryRecords(records, '', 'group', {kind: 'group', groupId: 'missing'}, groups), []);
});

test('旧展示偏好默认为全部范围，新组范围和组内排序可恢复', () => {
  storage.set('album-gallery-v1', JSON.stringify({mode: 'film'}));
  assert.deepEqual(gallery.readGalleryPreferences().scope, {kind: 'all'});
  const prefs = {...gallery.readGalleryPreferences(), scope: {kind: 'group', groupId: 'group-a'}, sort: 'group'};
  gallery.saveGalleryPreferences(prefs);
  assert.deepEqual(gallery.readGalleryPreferences(), prefs);
  assert.deepEqual(gallery.showcaseGroups({}), {revision: 0, groups: []});
});
