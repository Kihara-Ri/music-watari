import type {RecognitionFields, ReleaseInfo} from '../types';

export const releaseLabels: [keyof ReleaseInfo, string][] = [
  ['catalogNumber','唱片编号'], ['barcode','条码'], ['label','厂牌'], ['country','发行地区'],
  ['releaseDate','本版发行日期'], ['edition','发行版本'], ['format','介质'], ['discCount','碟数'],
  ['matrix','内圈刻码'], ['extras','可见附件与特典'], ['observations','照片可见情况'],
];

export function listingText(fields: RecognitionFields): string {
  const r = fields.releaseInfo ?? {};
  const lines = [[fields.artist, fields.title].filter(Boolean).join(' ')];
  for (const [label, value] of [['碟盒',fields.version],['版次',fields.pressing],['侧标',fields.obi]])
    if (value) lines.push(`${label}：${value}`);
  for (const [key,label] of releaseLabels) if (r[key]) lines.push(`${label}：${r[key]}`);
  return lines.filter(Boolean).join('\n');
}

export function newImportGroup(): import('../types').ImportGroup {
  return {id:crypto.randomUUID().replaceAll('-',''),photoIds:[],fields:{},protected:[],status:'idle',excluded:false,reviewed:false};
}
