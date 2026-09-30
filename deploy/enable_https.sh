#!/bin/sh
# 首次配置 HTTPS（在服务器上运行）：DNS 解析到本机入口后，webroot 方式向 Let's Encrypt 申请证书。
# 使用前把 DOMAIN 换成你的域名、APPSITE 换成 nginx 站点文件名；ACME_WEBROOT 与 nginx 配置保持一致。
set -eu
DOMAIN=your.domain
APPSITE=diedu
ACME_WEBROOT=/var/www/diedu-acme

# 可选校验：域名应解析到某台你控制的同入口主机（取消注释并填入参照域名）
# python3 - <<'PY'
# import socket
# actual={r[4][0] for r in socket.getaddrinfo('your.domain',80,type=socket.SOCK_STREAM)}
# expected={r[4][0] for r in socket.getaddrinfo('reference.example.com',80,type=socket.SOCK_STREAM)}
# if not actual.intersection(expected):raise SystemExit('域名入口与现有服务不一致，请检查 DNS')
# PY

sudo mkdir -p "$ACME_WEBROOT"
sudo certbot certonly --non-interactive --webroot -w "$ACME_WEBROOT" -d "$DOMAIN" --cert-name "$DOMAIN" --keep-until-expiring
sudo cp "/etc/nginx/sites-available/$APPSITE" "/etc/nginx/sites-available/$APPSITE.before-https"
sudo install -m 644 deploy/nginx.conf.template "/etc/nginx/sites-available/$APPSITE"
if ! sudo nginx -t; then
    sudo mv "/etc/nginx/sites-available/$APPSITE.before-https" "/etc/nginx/sites-available/$APPSITE"
    exit 1
fi
sudo systemctl reload nginx
printf 'HTTPS configured. Verify https://%s before daily use.\n' "$DOMAIN"
