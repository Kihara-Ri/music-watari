# 碟渡 · 项目标准（所有 agent 必读，违反红线的改动一律不接受）

个人 CD 收藏与交易账本：Python 标准库后端 + React/TS 前端 + SQLite，单用户，Mac 开发、服务器（Docker 或裸机）部署。
仓库是**可分享的框架**：不含任何个人数据（历史采购/运维记录在 `data/`，未跟踪），别人克隆后 `docker compose up -d --build` 即可开自己的实例。
动手前先读完本文件；与本文件冲突的旧做法以本文件为准。

## 开发复盘

后续开发同时查阅 [AI开发复盘.md](AI开发复盘.md) 中与任务相关的案例，先核对已有组件、所有使用入口与历史触发条件，避免再次要求用户提醒已定规则。复盘中的「待核查」是证据边界，不是已验证故障或新的业务决定；行为口径仍以本文件及用户最新明确要求为准。

## 红线

1. **服务端零第三方运行依赖**（纯标准库）。工具脚本可用标准库 + 已装库（如 PIL）。
2. **绝不触碰 `data/` 下已有数据**：代码只经 `storage.py` 的事务写库；任何脚本不得直接改 `data/*.sqlite3`。**仓库与 git 历史不得包含任何个人数据**（采购记录、成交截图、密码、域名、ssh 主机名等）。三道防线必须保持有效：
   - `.gitignore` 安全网（`*.sqlite3`/`.env`/`albums.json`/凭证目录等模式）；
   - 本地钩子 `tools/hooks/`（pre-commit 扫暂存区、pre-push 扫全树）——**克隆后必须执行 `tools/setup-hooks.sh` 启用**；
   - CI 权威闸门 `.github/workflows/ci.yml`（文件树 + 全历史扫描，红灯即修复，不得绕过）。
   共用检测脚本 `tools/check-data-leak.sh`；新增敏感模式要同时进它的 FILE_RE/CONTENT_RE。个人配置的真实值（域名/密钥/路径）只放 `data/`（未跟踪）或服务器上，仓库里一律用 `your.domain` 等占位符。
3. **金额语义**：服务端 Decimal、字符串传输；前端 `Number()` 仅用于显示。**成本缺失 = null，永不当 0**；利润只计成本已知的明细；分摊尾差保证总额不变。
4. **CSP 无内联**：不用内联 `<script>`/`<style>`；前端只用 ES module；外部资源仅限 CSP 白名单域。
5. **行为不变的重构必须零行为、零视觉变化**。业务口径、文案、交互有任何拿不准的，先问用户，不自作主张。

## 架构规则（加功能的唯一路径）

### 后端
- 新增 API = `server/routes.py` 表里加一行 + 一个处理函数。**禁止在 `server/http.py` 写具体接口**。
- 静态文件：`static/` 下任何真实文件自动可访问（`server/static_files.py`），无需登记；但启用登录后仅 `static_files.PUBLIC`（登录页及其渲染依赖、PWA 壳元数据）免登录，其余路径未登录一律服务端 302 到 `/login`。
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

### 功能组合

- 基础收藏始终可用；`acquisition`（购入记录）、`trading`（二手交易）、`circulation`（海外周转）按服务端 `modules-v1` 设置启用。海外周转依赖购入记录，交易可独立启用。
- 空白实例先选择组合；未配置且已有资料的实例保持全部功能。模块关闭只收起入口，禁止删除、归零或改写原业务记录；关闭海外周转时原持有/在途副本仍可在收藏中看到。
- 导航、手机更多页面、卡片、详情、单张/批量表单、统计与后端写操作必须使用同一配置。禁用模块的业务写入应明确报错，备份/恢复/导出始终可用。
- `storage` 是实物存放位置；`location` 仍是购买渠道。名称与艺人必填，购买金额与日期选填，未知成本仍为 null。
- 新模块的契约和验收入口见 [模块扩展指南](docs/模块扩展指南.md)，不引入动态插件加载或绕过 storage.py 写库。

### 界面规则

- 手机底栏为「库存 / 在途 / 售出中 / 更多」，按模块隐藏无关入口；国内/海外在库存页内切换。「更多」是独立页面，账本是其中的入口，不再使用更多弹出面板。
- 库存页支持列表/卡片切换，桌面与手机共用同一偏好、记住本浏览器选择；手机勾选框按需开启、编辑从详情进入，桌面保持常驻勾选与卡片上的编辑按钮。
- 批量操作条是**底部悬浮浮条**（position:fixed），不得挤压页面布局。
- 手机底栏选中高亮是一枚**滑动胶囊**（`.nav-pill`，App.tsx 内联 transform 定位槽位、CSS 过渡平移），各标签自身不再自绘激活背景。手机页面切换有**方向性过渡**（`styles/pagetransition.css`）：按导航层级 rank 决定方向——进更深页面从右推入、返回向右滑出；「更多」的子页（账本/已交易/统计/设置/回收站）统一右侧拉出。旧页由 App.tsx 在 hashchange/popstate 到达时抢先克隆 `#main` 做 DOM 快照参与滑出（组件不重复挂载，滚动偏移在克隆时一并记下）；**浏览器历史驱动的换页（popstate 且 hash 变化：iOS 边缘右滑、后退/前进键）不再自播动画——系统自带过渡画面，自播会双重动画**；抽屉的同址 popstate 守卫不得置该标记。桌面与 `prefers-reduced-motion` 一律不做切换动画。
- 排序 / 交易筛选用自定义 dd 下拉（`components/ui/Dropdown.tsx`），不用原生 select。
- 同专辑多副本分组：subgrid + `grid-column: span N`。**绝不能写 `1 / span N`**（强制换行、行尾留洞）。
- 默认排序按买入月份时间轴（时间轴仅此用途）；按艺人分组不用时间轴；库存（任意排序、列表/卡片）、售出中、交易、在途与专辑详情均使用独立艺人按钮打开碟渡内「艺人资料抽屉」（MusicBrainz 来源的身份绑定、资料与作品目录，入口 `forms/ArtistDrawer.tsx`）；未绑定艺人由服务端后台队列自动预取（账本写入/启动触发，节流+退避，单候选自动采用；多候选用本地专辑标题与 artist-credit 反向确认，证据不能区分时才人工选择），来源外链一律新标签页打开；RYM 直达已退役，历史 `rym-links`/`rym-token` 数据仍随备份保留。
- 日元价格只显示整数；人民币估算 1 位小数；卡片状态徽标用不透明深色底。
- **每张副本一条独立记录**（不做「一专辑多库存」）；`version`（碟盒）/`pressing`（版次）/`obi`（侧标，仅日版）三字段语义不得改。
- 实物照片存文件系统（`data/photos/<id>/`）不进 DB；缩略图点开灯箱；Esc 只关最顶层（灯箱优先于抽屉）。
- 表单抽屉默认一屏放完（`#panel` 紧凑压缩规则已调好，别放宽）。
- 外观三态（浅色 / 深色 / 跟随系统，默认跟随系统）入口：桌面页头右上角与手机「更多 · 管理」均为三段滑块（浅色/深色/跟随系统，点按直达不循环；复用 components/ui/Seg），手机行内展示当前生效外观（设置页不再有）。`static/theme.js` 是阻塞式引导脚本（CSP 禁内联）：首帧前写 `<html data-theme>` 并同步 theme-color meta，登录页与主应用共用；tokens.css 基础声明 = 深色兜底，`@supports (color:light-dark())` 内用 `light-dark()` 双值 + `color-scheme` 解析，新颜色一律走 token 不写死。

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
- **git**：语义化版本 tag（`v主.次.补丁`）。CI 绿灯才允许打 tag。**发布 Release =** 打 tag → `python3 tools/package_app.py`（VERSION 注入）→ `gh release create <tag> dist/album-ledger.tar.gz --generate-notes --notes "…"`，附 sha256。裸机发布 = `tools/deploy.sh`（release 布局 + 健康检查 + 自动回滚；首次 `--init`）。
- **服务器布局（裸机）**：`BASE/releases/<时间戳>/` + `current` 软链 + `data/` 与 `service.env` 在 releases 之外——**不得把数据放进 release 目录**。
- **数据安全三层**：每日快照（Backups）+ 发布前快照（deploy.sh）+ Litestream 异地复制（`deploy/litestream*.yml`）。动 schema 前必须确认快照存在。
- **文档即真相**：`README.md`、`使用说明.md`、`部署说明.md` 与实际行为必须同步，不同步视为未完成；文档不写具体个人的域名/路径/账号。
