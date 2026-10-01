#!/bin/bash
# 碟渡裸机发布脚本（在开发机上运行；服务器需 ssh 免密 + sudo）
#
#   DEPLOY_HOST=你的主机 tools/deploy.sh            常规发布：构建→打包→上传→健康检查→切软链→失败自动回滚
#   DEPLOY_HOST=你的主机 tools/deploy.sh --init     首次发布：初始化 release 布局并安装 systemd 服务
#   DEPLOY_HOST=你的主机 tools/deploy.sh --rollback 手动回滚上一版
#
# 想更省事直接用 Docker：docker compose up -d --build（见 docker-compose.yml）。
#
# 可用环境变量覆盖：DEPLOY_HOST（必填）、DEPLOY_DIR（默认 /opt/diedu）、
# SERVICE（默认 diedu）、APP_PORT（默认 8765）、KEEP_RELEASES（默认 5）。
# PACKAGE_PATH 可指定已校验的正式发布包；DEPLOY_HOST=local 供服务器补丁更新器调用。
# deploy/diedu.service 默认以 diedu 用户运行，按需先在服务器创建用户或改 unit。
# 注意：$VAR 后紧跟全角字符会被 macOS bash/zsh 并入变量名（C.UTF-8 locale），
# 一律写成 ${VAR} 形式；shebang 必须在首行，否则脚本由调用方 shell 解释。

set -euo pipefail

HOST="${DEPLOY_HOST:-}"
BASE="${DEPLOY_DIR:-/opt/diedu}"
SERVICE="${SERVICE:-diedu}"
APP_PORT="${APP_PORT:-8765}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
MODE="${1:-}"
PACKAGE_PATH="${PACKAGE_PATH:-}"
EXPECTED_VERSION="${EXPECTED_VERSION:-}"
EXPECTED_SHA256="${EXPECTED_SHA256:-}"
EXPECTED_PREVIOUS_VERSION="${EXPECTED_PREVIOUS_VERSION:-}"

[ -n "$HOST" ] || { echo "用法：DEPLOY_HOST=<ssh主机> tools/deploy.sh [--init|--rollback]" >&2; exit 1; }

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

say()  { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[deploy]\033[0m %s\n' "$*" >&2; exit 1; }

remote() {
  if [ "$HOST" = local ]; then bash -c "$1"; else ssh "$HOST" "$@"; fi
}

send_file() {
  if [ "$HOST" = local ]; then cp "$1" "$2"; else scp -q "$1" "$HOST:$2"; fi
}

# 同一台服务器的手动发布与自动补丁更新串行执行。
remote "sudo -n mkdir -p '$BASE' && sudo -n mkdir '$BASE/.deploy-lock'" || die "已有发布正在执行，或发布目录不可写"
trap 'remote "sudo -n rmdir '\''$BASE/.deploy-lock'\''" || true' EXIT
if [ -n "$EXPECTED_PREVIOUS_VERSION" ]; then
  CURRENT_VERSION="$(remote "cat '$BASE/current/VERSION'")"
  [ "$CURRENT_VERSION" != "$EXPECTED_VERSION" ] || exit 0
  [ "$CURRENT_VERSION" = "$EXPECTED_PREVIOUS_VERSION" ] || die "运行版本已变更，请重新检查更新"
fi

health() {  # 远端健康检查；输出 JSON，失败返回非零
  remote "curl -fsS -m 10 http://127.0.0.1:$APP_PORT/api/health" 2>/dev/null
}

switch_to() {  # 切软链（发布流程中服务已停，无并发窗口）
  remote "ln -sfn '$1' '$BASE/current'"
}

restart_service() { remote "sudo systemctl restart '$SERVICE'"; }

rollback_and_die() {
  say "健康检查失败，回滚到 $1"
  switch_to "$1"
  restart_service || true
  sleep 2
  die "已回滚到 $1；请查看远端 journalctl -u $SERVICE -n 50 定位问题"
}

# ── 手动回滚 ───────────────────────────────────────────────────────
if [ "$MODE" = "--rollback" ]; then
  PREV="$(remote "readlink '$BASE/current' || true")"
  [ -n "$PREV" ] || die "没有 current 软链，无法回滚"
  ALL="$(remote "ls -1d '$BASE/releases'/*/ | grep -v legacy | sort -r")"
  TARGET="$(echo "$ALL" | sed -n 2p)"
  [ -n "$TARGET" ] || die "没有可回滚的旧版本"
  switch_to "${TARGET%/}"
  restart_service
  sleep 2
  health >/dev/null && say "已回滚到 ${TARGET%/}" || die "回滚后健康检查仍失败"
  exit 0
fi

# ── 构建与打包（本地）──────────────────────────────────────────────
if [ -z "$PACKAGE_PATH" ]; then
  say "构建前端…"
  npm --prefix web run build >/dev/null
  say "打包（git 版本号写入 VERSION）…"
  python3 tools/package_app.py
  PACKAGE_PATH="$ROOT/dist/album-ledger.tar.gz"
fi
PACKAGE_PATH="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve())' "$PACKAGE_PATH")"
PACKAGE_VERSION="$(tar -xOf "$PACKAGE_PATH" VERSION)"
[ -n "$EXPECTED_VERSION" ] || EXPECTED_VERSION="$PACKAGE_VERSION"
[ "$PACKAGE_VERSION" = "$EXPECTED_VERSION" ] || die "发布包版本与目标版本不一致"
if [ -n "$EXPECTED_SHA256" ]; then
  ACTUAL_SHA256="$(python3 -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1],"rb").read()).hexdigest())' "$PACKAGE_PATH")"
  [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || die "发布包 SHA256 校验失败"
fi

# ── 上传与解压 ─────────────────────────────────────────────────────
remote "mkdir -p '$BASE/releases'"
say "上传并解压到 releases/$STAMP …"
send_file "$PACKAGE_PATH" "/tmp/album-ledger-$STAMP.tar.gz"
remote "mkdir -p '$BASE/releases/$STAMP' && tar -xzf /tmp/album-ledger-$STAMP.tar.gz -C '$BASE/releases/$STAMP' && rm /tmp/album-ledger-$STAMP.tar.gz"

# ── 首次初始化：release 布局 + systemd 服务 ────────────────────────
if [ "$MODE" = "--init" ]; then
  if remote "[ -f '$BASE/app.py' ]"; then
    say "检测到扁平安装，迁入 releases/legacy-${STAMP}（data/ 原地保留）"
    remote "mkdir -p '$BASE/releases/legacy-$STAMP' && cd '$BASE' && find . -maxdepth 1 -mindepth 1 \
      ! -name data ! -name releases ! -name service.env ! -name current ! -name .deploy-lock -exec mv {} releases/legacy-$STAMP/ \;"
  fi
  say "安装 systemd unit（${SERVICE}，按需先在服务器创建 diedu 用户）"
  send_file deploy/diedu.service /tmp/diedu.service
  remote "sudo mv /tmp/diedu.service /etc/systemd/system/$SERVICE.service && sudo systemctl daemon-reload && sudo systemctl enable '$SERVICE'"
  [ -f "$ROOT/deploy/service.env.example" ] || true
  remote "[ -f '$BASE/service.env' ] || { echo 'PUBLIC_ORIGIN=' > '$BASE/service.env'; chmod 600 '$BASE/service.env'; }"
fi

# ── 切换前快照数据库（服务停止时拷贝）─────────────────────────────
PREV="$(remote "readlink '$BASE/current' || true")"
say "停服务并快照数据库"
remote "sudo -n systemctl stop '$SERVICE'"
if ! remote "if [ -f '$BASE/data/albums.sqlite3' ]; then sudo -n cp '$BASE/data/albums.sqlite3' '$BASE/data/pre-deploy-$STAMP.sqlite3'; fi"; then
  restart_service || true
  die "发布前快照失败，保留原版本"
fi

if ! switch_to "$BASE/releases/$STAMP" || ! restart_service; then
  [ -z "$PREV" ] || rollback_and_die "$PREV"
  die "新版本启动失败且没有可回滚的旧版本"
fi

# ── 健康检查，失败即回滚 ───────────────────────────────────────────
sleep 2
for i in 1 2 3 4 5; do
  if H="$(health)" && python3 -c 'import json,sys; h=json.loads(sys.argv[1]); sys.exit(0 if h.get("ok") is True and h.get("version")==sys.argv[2] else 1)' "$H" "$EXPECTED_VERSION"; then
    say "健康检查通过：$H"
    say "发布完成：$BASE/releases/${STAMP}（上一版：${PREV:-无}）"
    remote "cd '$BASE/releases' && ls -1d */ | grep -v legacy | sort | head -n -$KEEP_RELEASES | xargs -r rm -rf"
    exit 0
  fi
  say "等待服务就绪（$i/5）…"; sleep 3
done

if [ -n "$PREV" ]; then rollback_and_die "$PREV"; fi
die "健康检查失败且没有可回滚的旧版本；查看 journalctl -u $SERVICE -n 50"
