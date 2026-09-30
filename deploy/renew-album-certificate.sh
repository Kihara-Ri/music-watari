#!/bin/sh
# 证书续期后自动重载 nginx：本脚本装到 /etc/letsencrypt/renewal-hooks/deploy/ 即生效。
# DOMAIN 与签发时保持一致。
DOMAIN=your.domain
if [ "${RENEWED_LINEAGE:-}" = "/etc/letsencrypt/live/$DOMAIN" ]; then
    /usr/sbin/nginx -t
    /usr/bin/systemctl reload nginx
fi
