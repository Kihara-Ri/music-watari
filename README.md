# 碟渡 · music-watari

> **渡り**（watari）＝ 渡。让每一张漂洋过海的 CD，都被好好记着。

个人 CD 收藏与交易账本：从日本买入、打包运回、上架售出、落袋为安——每张专辑的完整旅程与每一分钱的成本利润，都清清楚楚。

## 功能一览

- **五态生命周期**：海外库存 → 打包运输（运费自动均摊进成本）→ 海外在途 →签收→ 国内库存 → 售出中 →确认收货→ 已交易（现金）。
- **全自动**：封面从 iTunes / MusicBrainz 抓取（唯一精确匹配自动带入）；日元成本按购买当天的欧洲央行汇率折算，缺失时显示「待补」，永不当零。
- **好用的录入**：添加专辑必填仅 4 项；库内模糊匹配（罗马音 / 艺人别名 / 容错），批量录入、合单售出、实物照片（HEIC 自动压缩）。
- **RYM 艺人直达**：「按艺人」视图点艺人名直达 RateYourMusic 艺人页。首次需绑定：设置页把「绑定到碟渡」书签拖到书签栏，在 RYM 选中艺人后点一下即可（RYM 挡所有自动化访问，绑定是唯一可靠路径）；绑定随备份保存。
- **账目清楚**：人民币统一口径，Decimal 精确到分；利润只计成本已知的交易；按月收支统计、CSV 导出。
- **属于自己的**：数据全在本地 SQLite，PWA 可安装到手机主屏，服务端零第三方依赖。

## 快速开始

**Docker（推荐，一键）：**

```sh
git clone https://github.com/Kihara-Ri/music-watari && cd music-watari
cp .env.example .env          # 按需填 PUBLIC_ORIGIN / 备份密钥
docker compose up -d --build
# 打开 http://127.0.0.1:8765 —— 数据全部落在 ./data，与代码解耦
```

升级 = `git pull && docker compose up -d --build`；停止 = `docker compose down`（数据保留）。

也可以在 [Releases](https://github.com/Kihara-Ri/music-watari/releases) 直接下载 `album-ledger.tar.gz`（无需 git，裸机 Python 运行，见部署说明）。

**裸 Python（零依赖运行）：**

```sh
python3 app.py            # Python 3.10+，无需安装任何依赖
# 打开 http://127.0.0.1:8765
```

Mac 上也可以直接双击 `启动碟渡.command`。

有历史采购记录（albums.json 格式）？把它放进数据目录（`data/`），首次启动自动导入。公网部署（HTTPS 反代 + 登录密码 + 异地备份）见[部署说明](部署说明.md)。

## 结构

```
app.py            入口：CLI / 服务组装 / 启动（支持 HOST/PORT/DATA_DIR/PUBLIC_ORIGIN 环境变量）
server/           HTTP 层：路由表 · 静态服务 · CSV 导出（加接口只改一张表）
domain.py         金额计算与校验（Decimal，纯函数）
storage.py        SQLite 事务与持久化（五态 + 包裹 + 销售单）
rates.py          历史汇率（frankfurter.dev，本地缓存）
covers.py         封面抓取（iTunes / MusicBrainz / CAA）
security.py       登录、会话与限流
backups.py        每日一致性快照
web/              前端源码：React 19 + TypeScript + Vite
static/           构建产物与 PWA 资源（npm --prefix web run build）
Dockerfile        多阶段构建：Node 打前端 → 纯标准库 Python 运行
docker-compose.yml  一键部署 + 可选 Litestream 异地备份
deploy/           systemd / nginx / Litestream 配置（裸机方案）
tools/            deploy.sh 发布 · 打包 · 数据导入脚本
```

## 文档

- [使用说明](使用说明.md) —— 状态模型、日常操作与计算口径
- [部署说明](部署说明.md) —— Docker / 裸机部署、HTTPS 公网访问与数据容灾
- [AGENTS.md](AGENTS.md) —— 开发标准与红线（agent / 贡献者必读）
- [AI 开发复盘](AI开发复盘.md) —— 产品演进、历史纠错、原因与后续开发验收案例

功能组合支持纯收藏、收藏与购入、收藏与交易及海外周转，可随时在设置调整；基础收藏始终可用。

## 验证

```sh
python3 -m unittest discover -s tests -v
npm --prefix web run typecheck && npm --prefix web run build
```

每次 push 由 GitHub Actions 自动执行同样的测试 + **数据泄漏扫描**（个人数据文件与身份串不得入库）。本地开发请先执行一次 `tools/setup-hooks.sh` 启用 commit/push 拦截钩子——仓库不含任何个人数据，这条红线靠上面三层防线保证。

---

*音乐渡海而来，账目清清楚楚。*
