#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Serve the dashboard on your own domain over HTTPS, on a VPS where Xray
# already owns port 443.
#
#   browser --HTTPS--> Cloudflare (edge cert) --HTTP:80--> nginx --> container
#
# Because :443 belongs to Xray we cannot bind it or run certbot here, so
# Cloudflare terminates TLS at the edge and talks to this origin over :80.
# Xray is never touched.
#
# Usage:
#   sudo bash deploy/setup-domain.sh <domain> [upstream_host:port]
#   sudo bash deploy/setup-domain.sh dashboard.trackydev.site 127.0.0.1:8090
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${1:-}"
UPSTREAM="${2:-127.0.0.1:8090}"
[[ -z "$DOMAIN" ]] && { echo "usage: sudo bash $0 <domain> [upstream_host:port]"; exit 1; }
[[ $EUID -ne 0 ]] && { echo "ERROR: run with sudo."; exit 1; }

say() { echo -e "\n>> $*"; }

say "Checking the upstream container at ${UPSTREAM} ..."
UP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://${UPSTREAM}/" || echo 000)"
if [[ "$UP_CODE" == "000" ]]; then
  echo "!! Nothing is answering on ${UPSTREAM}."
  echo "   Start the dashboard container first (Coolify -> Deploy), or pass the"
  echo "   correct host:port as the 2nd argument. Continuing anyway..."
else
  echo "   OK - upstream responded with HTTP ${UP_CODE}"
fi

say "Ensuring nginx is installed ..."
command -v nginx >/dev/null 2>&1 || { apt-get update -y; apt-get install -y nginx; }

say "Writing the site config ..."
AVAIL=/etc/nginx/sites-available/xui-dashboard.conf
ENABLED=/etc/nginx/sites-enabled/xui-dashboard.conf

cat > "$AVAIL" <<EOF
upstream xui_dashboard { server ${UPSTREAM}; keepalive 16; }

server {
    listen 80;
    listen [::]:80;
    server_name ${DOMAIN};

    client_max_body_size 64m;

    location / {
        proxy_pass http://xui_dashboard;
        proxy_http_version 1.1;

        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        # Cloudflare terminated TLS for us, so tell the app the original
        # scheme was https (falls back to \$scheme when hit directly).
        proxy_set_header X-Forwarded-Proto \$http_x_forwarded_proto;
        proxy_set_header CF-Connecting-IP  \$http_cf_connecting_ip;

        # Server-Sent Events (/api/stream, /public/stream) must not be buffered.
        proxy_set_header Connection        "";
        proxy_buffering                    off;
        proxy_cache                        off;
        chunked_transfer_encoding          off;
        proxy_read_timeout                 3600s;
        proxy_send_timeout                 3600s;
    }
}
EOF

ln -sf "$AVAIL" "$ENABLED"

# The stock "Welcome to nginx" site is a default_server and will answer for any
# hostname that doesn't match ours - remove it so it can't shadow the dashboard.
if [[ -e /etc/nginx/sites-enabled/default ]]; then
  say "Removing the default nginx site so it can't shadow this one ..."
  rm -f /etc/nginx/sites-enabled/default
fi

# Clear stale symlinks from earlier attempts (these break 'nginx -t').
for stale in /etc/nginx/sites-enabled/*; do
  [[ -L "$stale" && ! -e "$stale" ]] && { echo ">> Removing broken symlink: $stale"; rm -f "$stale"; }
done

say "Validating the config ..."
nginx -t

# nginx may be running OUTSIDE systemd (started by hand earlier). In that case
# 'systemctl reload' fails while the orphan keeps serving a stale config, which
# looks exactly like "my changes did nothing".
say "Restarting nginx (handling any process not managed by systemd) ..."
if systemctl is-active --quiet nginx; then
  systemctl reload nginx || systemctl restart nginx
else
  if pgrep -f 'nginx: master' >/dev/null 2>&1; then
    echo "   Found an nginx process outside systemd - stopping it first."
    pkill -f 'nginx: master' || true
    sleep 1
  fi
  systemctl enable nginx >/dev/null 2>&1 || true
  systemctl start nginx
fi

sleep 1
if ! systemctl is-active --quiet nginx; then
  echo "!! nginx still isn't running. Check: sudo journalctl -xeu nginx | tail -30"
  echo "   Also check nothing else holds :80 -> sudo ss -tulpn | grep ':80 '"
  exit 1
fi
echo "   nginx is active."

say "Verifying the origin now serves the dashboard ..."
BODY="$(curl -s --max-time 5 -H "Host: ${DOMAIN}" http://127.0.0.1/ | head -c 400 || true)"
if grep -qi 'welcome to nginx' <<<"$BODY"; then
  echo "!! Still serving the default nginx page - the site isn't matching."
  echo "   Enabled sites:"; ls -l /etc/nginx/sites-enabled/
  exit 1
elif grep -qi '<!doctype html' <<<"$BODY"; then
  echo "   OK - the dashboard HTML is being served on :80 for ${DOMAIN}"
else
  echo "   Origin replied, but the body was unexpected (upstream may be down):"
  echo "   ${BODY:0:160}"
fi

cat <<EOF

======================================================================
Origin is ready.  Finish in the Cloudflare dashboard (one time):

  1. DNS
       Type A   Name ${DOMAIN%%.*}   Content <this VPS public IP>
       Proxy status: Proxied  (ORANGE cloud)

  2. SSL/TLS -> Overview -> encryption mode: Flexible
       Required: your :443 is Xray, so Cloudflare must reach this origin
       over plain HTTP on :80. In Full/Strict it would try :443, hit Xray,
       and fail with error 525/526.

  3. Open  https://${DOMAIN}

Notes
  * Leave the Domain field EMPTY in Coolify. nginx owns :80 here, so
    Coolify's proxy cannot also bind it - nginx is doing the routing.
  * Xray keeps :443 untouched.
  * Flexible means the Cloudflare->origin hop is not encrypted. Your config
    links contain client UUIDs, so if you want end-to-end TLS see
    "Upgrading to full encryption" in deploy/README-domain.md.
======================================================================
EOF
