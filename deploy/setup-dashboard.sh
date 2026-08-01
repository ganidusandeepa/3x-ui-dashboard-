#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-shot automated setup for serving the 3x-ui dashboard on an HTTPS
# subdomain via nginx, on a VPS where 3x-ui already owns ports 80/443 through
# the SAME nginx. Safe to re-run (idempotent). Also repairs a broken
# sites-enabled symlink left by a previous failed attempt.
#
# Usage:
#   sudo bash setup-dashboard.sh <domain> [upstream_host:port] [email]
#
# Examples:
#   sudo bash setup-dashboard.sh vps.trackydev.site
#   sudo bash setup-dashboard.sh vps.trackydev.site 127.0.0.1:8090 you@mail.com
#
# Prerequisites:
#   * DNS A record for <domain> -> this VPS IP (Cloudflare: set DNS-only / grey
#     cloud, otherwise HTTP-01 cert validation fails).
#   * The dashboard container is published on <upstream_host:port>
#     (default 127.0.0.1:8090) via Coolify Ports Mapping or docker-compose.yml.
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${1:-}"
UPSTREAM="${2:-127.0.0.1:8090}"
EMAIL="${3:-}"

if [[ -z "$DOMAIN" ]]; then
  read -rp "Domain to serve the dashboard on (e.g. vps.trackydev.site): " DOMAIN
fi
[[ -z "$DOMAIN" ]] && { echo "ERROR: a domain is required."; exit 1; }
[[ $EUID -ne 0 ]] && { echo "ERROR: run with sudo/root."; exit 1; }

echo ">> Ensuring nginx + certbot are installed..."
if ! command -v nginx >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y nginx
fi
if ! command -v certbot >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y certbot python3-certbot-nginx
fi

AVAIL=/etc/nginx/sites-available/xui-dashboard.conf
ENABLED=/etc/nginx/sites-enabled/xui-dashboard.conf
# Clean up the specific broken symlink from the earlier failed manual attempt.
for stale in /etc/nginx/sites-enabled/dashboard.conf "$ENABLED"; do
  if [[ -L "$stale" && ! -e "$stale" ]]; then
    echo ">> Removing broken symlink: $stale"
    rm -f "$stale"
  fi
done

echo ">> Writing nginx config for $DOMAIN -> $UPSTREAM ..."
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
        proxy_set_header X-Forwarded-Proto \$scheme;

        # Server-Sent Events (/api/stream, /public/stream) need buffering off.
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

echo ">> Testing nginx config..."
nginx -t
echo ">> Reloading nginx..."
systemctl reload nginx

echo ">> Requesting/installing TLS certificate via certbot..."
if [[ -n "$EMAIL" ]]; then
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect || \
    echo "!! certbot failed — check the DNS A record points here and is DNS-only (grey cloud). nginx is still serving HTTP."
else
  certbot --nginx -d "$DOMAIN" --redirect || \
    echo "!! certbot failed — check the DNS A record points here and is DNS-only (grey cloud). nginx is still serving HTTP."
fi

echo ""
echo ">> Done. Your dashboard should be reachable at: https://${DOMAIN}"
echo "   (If you see 502 Bad Gateway, the container isn't published on ${UPSTREAM} yet —"
echo "    set the Coolify Ports Mapping to 127.0.0.1:8090:8080 or deploy via docker-compose.yml.)"
