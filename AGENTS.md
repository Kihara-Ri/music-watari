# 碟渡 · 项目标准（所有 agent 必读，违反红线的改动一律不接受）

个人 CD 收藏与交易账本：Python 标准库后端 + React/TS 前端 + SQLite，单用户，Mac 开发、服务器（Docker 或裸机）部署。
仓库是**可分享的框架**：不含任何个人数据（历史采购/运维记录在 `data/`，未跟踪），别人克隆后 `docker compose up -d --build` 即可开自己的实例。
动手前先读完本文件；与本文件冲突的旧做法以本文件为准。

## 红线

1. **服务端零第三方运行依赖**（纯标准库）。工具脚本可用标准库 + 已装库（如 PIL）。
2. **绝不触碰 `data/` 下已有数据**：代码只经 `storage.py` 的事务写库；任何脚本不得直接改 `data/*.sqlite3`。**仓库与 git 历史不得包含任何个人数据**（采购记录、成交截图、密码、域名等）——`data/` 已整体 gitignore，历史数据导入文件放 `data/albums.json`。
3. **金额语义**：服务端 Decimal、字符串传输；前端 `Number()` 仅用于显示。**成本缺失 = null，永不当 0**；利润只计成本已知的明细；分摊尾差保证总额不变。
4. **CSP 无内联**：不用内联 `<script>`/`<style>`；前端只用 ES module；外部资源仅限 CSP 白名单域。
5. **行为不变的重构必须零行为、零视觉变化**。业务口径、文案、交互有任何拿不准的，先问用户，不自作主张。

## 架构规则（加功能的唯一路径）

### 后端
- 新增 API = `server/routes.py` 表里加一行 + 一个处理函数。**禁止在 `server/http.py` 写具体接口**。
- 静态文件：`static/` 下任何真实文件自动可访问（`server/static_files.py`），无需登记。
  手工维护的静态文件：`login.html`、`login.js`、`offline.html`、`sw.js`、`manifest.webmanifest`、图标、`vendor/`。
- `app.py` 只做 CLI / 组装 / 启动。服务一律经 `server.context.Services` 注入，**禁止模块级单例**（import 零副作用）。
- 根目录业务模块（`domain/storage/covers/rates/security/backups`）**不得移动或重命名**（`tools/` 依赖顶层 import 路径）；`storage.py` 保持单文件（跨表事务 + 审计内聚，不拆）。
- 版本：发布包带 `VERSION`（git describe 生成），`/api/health` 与设置页显示。

### 前端（`web/`，React 19 + TS strict + Vite）
- 分层单向依赖：`core/` ← `components/` ← `pages/` 与 `forms/`；**禁止反向 import**。
- 全局状态只经 `src/state/AppContext.ts`；禁止新增模块级可变全局。
- 新页面 = `src/pages/` 加模块 + `App.tsx` 分发加一行；新表单 = `src/forms/` 加模块。
- 样式只放 `src/styles/<模块>.css` 并在 `main.tsx` 按序 import（tokens → base → layout → components → 各页面模块）；`@media` 跟随所属模块；文件不超过一个职责。
- **改完必须** `npm --prefix web run typecheck && npm --prefix web run build`——服务端只认 `static/assets/` 构建产物，改源码不构建等于没改。
- `static/assets` 文件名保持稳定（不哈希）：服务端 `Cache-Control: no-store`，哈希无意义且测试断言固定路径。

## 用户已定案的 UI 偏好（不得回退）

- 批量操作条是**底部悬浮浮条**（position:fixed），不得挤压页面布局。
- 排序 / 交易筛选用自定义 dd 下拉（`components/ui/Dropdown.tsx`），不用原生 select。
- 同专辑多副本分组：subgrid + `grid-column: span N`。**绝不能写 `1 / span N`**（强制换行、行尾留洞）。
- 默认排序按买入月份时间轴（时间轴仅此用途）；按艺人分组不用时间轴；艺人名链接新标签页跳 RateYourMusic。
- 日元价格只显示整数；人民币估算 1 位小数；卡片状态徽标用不透明深色底。
- **每张副本一条独立记录**（不做「一专辑多库存」）；`version`（碟盒）/`pressing`（版次）/`obi`（侧标，仅日版）三字段语义不得改。
- 实物照片存文件系统（`data/photos/<id>/`）不进 DB；缩略图点开灯箱；Esc 只关最顶层（灯箱优先于抽屉）。
- 表单抽屉默认一屏放完（`#panel` 紧凑压缩规则已调好，别放宽）。

## 验证门槛（全部通过才算完成）

```sh
python3 -m unittest discover -s tests -v                                   # 后端全绿
npm --prefix web run typecheck && npm --prefix web run build               # 前端
python3 app.py --port <空闲端口> --data-dir /private/tmp/xxx --no-seed      # 浏览器验证
```

- **8765 等本机常用端口可能被常驻服务占用**——验证一律用空闲端口（如 8791）+ 临时数据目录 + `--no-seed`；Docker 验证用独立端口与临时卷。
- 涉及 UI 的改动必须浏览器实测：console 零报错 + 关键流程走通。
- 截图视觉验收要等动画结束（灯箱 0.15s / 抽屉 0.22s）再判断。

## 发布与运维标准

- **Docker 一键部署是主路径**：`docker compose up -d --build`。改了 `Dockerfile` / `docker-compose.yml` / `web/` / `static/` 中任何构建输入，必须实测 `docker compose build` 通过再提交；`.dockerignore` 与 Dockerfile 的 COPY 清单保持同步（新目录默认不进镜像）。
- **数据与框架解耦**：容器数据只写 `/data` 卷；compose 挂载 `./data`；任何代码不得把用户数据写到其他位置。
- **git**：语义化版本 tag（`v主.次.补丁`）；远端历史必须干净（不引入个人数据后**严禁**普通提交——需重建历史）。裸机发布 = `tools/deploy.sh`（release 布局 + 健康检查 + 自动回滚；首次 `--init`）。
- **服务器布局（裸机）**：`BASE/releases/<时间戳>/` + `current` 软链 + `data/` 与 `service.env` 在 releases 之外——**不得把数据放进 release 目录**。
- **数据安全三层**：每日快照（Backups）+ 发布前快照（deploy.sh）+ Litestream 异地复制（`deploy/litestream*.yml`）。动 schema 前必须确认快照存在。
- **文档即真相**：`README.md`、`使用说明.md`、`部署说明.md` 与实际行为必须同步，不同步视为未完成；文档不写具体个人的域名/路径/账号。
