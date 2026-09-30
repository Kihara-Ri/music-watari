#!/bin/sh
# 一次性启用本地数据防护钩子（克隆仓库后必须执行一次）。
# 原理：core.hooksPath 指向仓库内的 tools/hooks/，commit/push 前自动跑数据泄漏扫描。
# 本地钩子只是第一道防线；GitHub Actions（.github/workflows/ci.yml）是权威闸门。
cd "$(dirname "$0")/.."
chmod +x tools/hooks/pre-commit tools/hooks/pre-push tools/check-data-leak.sh
git config core.hooksPath tools/hooks
echo "✓ 已启用 pre-commit / pre-push 数据泄漏拦截（core.hooksPath=tools/hooks）"
