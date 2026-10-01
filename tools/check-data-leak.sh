#!/bin/sh
# 数据泄漏扫描：本地钩子（--cached 扫暂存区）与 CI（tree 扫 tracked 全量）共用。
# 拦截两类内容：①数据文件（数据库/备份/凭证/环境密钥/个人文档）②个人身份串与私钥。
set -eu
cd "$(git rev-parse --show-toplevel)"

# 自匹配防护：下面的敏感串用字符类打碎明文（正则仍命中目标，但本文件不含目标明文）
FILE_RE='(^data/|\.sqlite3$|\.sqlite3-|\.env$|(^|/)vision-config\.json$|/albums\.json$|^albums\.json$|部署登录信息|出售记录|封面核对报告|管理系统方案|运营记录)'
CONTENT_RE='kihara[.]cn|ras[p]5|kihara00[4]5|BEGIN [A-Z ]*PRIVATE KEY'

fail=0
if [ "${1:-tree}" = "--cached" ]; then
    names=$(git diff --cached --name-only || true)
    bad_content=$(git grep --cached -lIE "$CONTENT_RE" -- . 2>/dev/null || true)
else
    names=$(git ls-files)
    bad_content=$(git grep -lIE "$CONTENT_RE" -- . 2>/dev/null || true)
fi

bad_files=$(printf '%s\n' "$names" | grep -E "$FILE_RE" || true)
if [ -n "$bad_files" ]; then
    echo "✗ 以下文件属于个人数据 / 密钥，不得入库（移到 data/ 或加入 .gitignore）："
    echo "$bad_files"
    fail=1
fi
if [ -n "$bad_content" ]; then
    echo "✗ 以下文件包含个人身份串（域名/主机/邮箱）或私钥，请用占位符替换："
    echo "$bad_content"
    fail=1
fi

if [ "$fail" -eq 0 ]; then
    echo "✓ 数据泄漏扫描通过"
fi
exit $fail
