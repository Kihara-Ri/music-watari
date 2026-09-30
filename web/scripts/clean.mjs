// 构建前清掉上一轮产物（只动 assets/ 与 index.html，不碰手工维护的静态文件）。
import {rmSync} from 'node:fs';

rmSync(new URL('../../static/assets', import.meta.url), {recursive: true, force: true});
rmSync(new URL('../../static/index.html', import.meta.url), {force: true});
