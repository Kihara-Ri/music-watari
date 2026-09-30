#!/bin/sh
# Run on rasp5 after DNS for albums.kihara.cn resolves to the service entrance.
set -eu
cd /home/kihara/album-ledger
python3 - <<'PY'
import socket
try:
    actual={r[4][0] for r in socket.getaddrinfo('albums.kihara.cn',80,type=socket.SOCK_STREAM)}
    expected={r[4][0] for r in socket.getaddrinfo('file.kihara.cn',80,type=socket.SOCK_STREAM)}
except OSError:raise SystemExit('域名尚未解析，暂不申请证书')
if not actual.intersection(expected):raise SystemExit('域名入口与现有服务不一致，请检查 DNS')
PY
sudo certbot certonly --non-interactive --webroot -w /var/www/album-ledger-acme -d albums.kihara.cn --cert-name albums.kihara.cn --keep-until-expiring
sudo cp /etc/nginx/sites-available/album-ledger /etc/nginx/sites-available/album-ledger.before-https
sudo install -m 644 deploy/nginx.conf.template /etc/nginx/sites-available/album-ledger
if ! sudo nginx -t; then
    sudo mv /etc/nginx/sites-available/album-ledger.before-https /etc/nginx/sites-available/album-ledger
    exit 1
fi
sudo systemctl reload nginx
printf 'HTTPS configured. Verify https://albums.kihara.cn before daily use.\n'
