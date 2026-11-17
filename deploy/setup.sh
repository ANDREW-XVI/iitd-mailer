#!/usr/bin/env bash
# Installs or updates IITD Mailer on an Ubuntu server (made for Oracle Cloud "Always Free").
# Run on the server, from the folder you copied:   sudo bash ~/iitd-mailer/deploy/setup.sh
# Safe to run again after copying a newer version: your lists, log and settings are kept.
#
#   DOMAIN=mail.example.com sudo -E bash deploy/setup.sh   -> use your own domain instead of <ip>.sslip.io
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash $0"; exit 1; fi
SRC="$(cd "$(dirname "$0")/.." && pwd)"
APP=/opt/iitd-mailer
DATA=/var/lib/iitd-mailer
ENVFILE=/etc/iitd-mailer.env
PORT=8765

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

say "1/6  Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq python3 python3-venv rsync curl gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent >/dev/null
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

say "2/6  Copying the app to $APP"
id mailer >/dev/null 2>&1 || useradd --system --home "$DATA" --shell /usr/sbin/nologin mailer
mkdir -p "$APP" "$DATA"
rsync -a --delete --exclude data --exclude venv --exclude sent_log.csv --exclude '__pycache__' "$SRC"/ "$APP"/
# a sent_log.csv copied from your laptop is merged in once, so the server knows what was sent
if [ -f "$SRC/sent_log.csv" ] && [ ! -f "$DATA/sent_log.csv" ]; then cp "$SRC/sent_log.csv" "$DATA/sent_log.csv"; fi
python3 -m venv "$APP/venv"
"$APP/venv/bin/pip" install -q --upgrade pip
"$APP/venv/bin/pip" install -q -r "$APP/requirements.txt"
chown -R root:root "$APP"
chown -R mailer:mailer "$DATA"; chmod 700 "$DATA"

say "3/6  App sign-in password"
if [ ! -f "$ENVFILE" ]; then
  PW="$(python3 -c 'import secrets; print(secrets.token_urlsafe(15))')"
  printf 'MAILER_LOGIN_PASSWORD=%s\n' "$PW" > "$ENVFILE"
  NEWPW=1
fi
chmod 600 "$ENVFILE"

say "4/6  Starting the app as a service"
cat > /etc/systemd/system/iitd-mailer.service <<EOF
[Unit]
Description=IITD Mailer
After=network-online.target
Wants=network-online.target

[Service]
User=mailer
Group=mailer
WorkingDirectory=$APP
EnvironmentFile=$ENVFILE
Environment=MAILER_MODE=server MAILER_DATA=$DATA MAILER_LOG=$DATA/sent_log.csv PORT=$PORT MAILER_HOST=127.0.0.1 PYTHONUNBUFFERED=1
ExecStart=$APP/venv/bin/python $APP/app.py
Restart=always
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now iitd-mailer >/dev/null
systemctl restart iitd-mailer

say "5/6  HTTPS address"
IP="$(curl -fsS https://api.ipify.org || true)"
if [ -z "${DOMAIN:-}" ]; then
  if [ -z "$IP" ]; then echo "Couldn't find this server's public IP. Run again with DOMAIN=<your domain>."; exit 1; fi
  DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:$PORT
}
EOF
# Oracle's Ubuntu images block web traffic in the server's own firewall; let 80 and 443 in.
for p in 80 443; do
  iptables -C INPUT -p tcp -m state --state NEW --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp -m state --state NEW --dport "$p" -j ACCEPT
done
netfilter-persistent save >/dev/null 2>&1 || true
systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy

say "6/6  Can this server reach IIT Delhi's mail server?"
"$APP/venv/bin/python" "$APP/deploy/check_smtp.py" || true

sleep 2
if systemctl is-active --quiet iitd-mailer; then STATE="running"; else STATE="NOT running (see: sudo journalctl -u iitd-mailer -n 50)"; fi
echo
echo "------------------------------------------------------------------"
echo " IITD Mailer is $STATE"
echo " Open:      https://$DOMAIN"
if [ "${NEWPW:-0}" = 1 ]; then
echo " Sign in with this app password (shown once, write it down):"
echo "            $PW"
else
echo " App password: unchanged (it's in $ENVFILE)"
fi
echo " If the page doesn't load, open ports 80 and 443 in Oracle's"
echo " security list (DEPLOY.md, step 3). The HTTPS certificate is"
echo " created on the first visit and can take a minute."
echo "------------------------------------------------------------------"
