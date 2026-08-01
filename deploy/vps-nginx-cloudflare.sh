#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Expose the 3x-ui dashboard container on a clean domain WITHOUT touching Xray.
#
# Context: Xray already owns :443 on this box, so we cannot bind 443 locally and
# cannot use certbot (its HTTP-01 -> HTTPS flow wants 443). Instead:
#   * nginx listens on :80 and reverse-proxies to the dashboard container
#   * Cloudflare (orange-cloud / proxied) terminates TLS at the edge and talks
#     to this origin over :80.  ->  https://<domain> works, Xray keeps :443.
#
# This script ONLY configures nginx on :80. It never touches :443 or Xray.
# Safe to re-run (idempotent).
#
# Usage:
#   sudo bash deploy/vps-nginx-cloudflare.sh <domain> [upstream_host:port]
# Examples:
#   sudo bash deploy/vps-nginx-cloudflare.sh vps.trackydev.site
#   sudo bash deploy/vps-nginx-cloudflare.sh vps.trackydev.site 127.0.0.1:8090
# ---------------------------------------------------------------------------
set -euo pipefail

DOMAIN="${1:-}"
UPSTREAM="${2:-}"
[[ -z "$DOMAIN" ]] && { echo "ERROR: usage: sudo bash $0 <domain> [upstream_host:port]"; exit 1; }
[[ $EUID -ne 0 ]] && { echo "ERROR: run with sudo/root."; exit 1; }

DOCKER="$(command -v docker || true)"
[[ -z "$DOCKER" ]] && for d in /usr/bin/docker /usr/local/bin/docker /snap/bin/docker; do [[ -x "$d" ]] && DOCKER="$d" && break; done

# --- 1. Figure out where the dashboard container is reachable -----------------
if [[ -z "$UPSTREAM" && -n "$DOCKER" ]]; then
  CID="$($DOCKER ps --format '{{.ID}} {{.Names}}' 2>/dev/null | grep -i dash | awk '{print $1}' | head -1 || true)"
  if [[ -n "$CID" ]]; then
    # (a) prefer a published host port mapped to container :8080
    MAP="$($DOCKER inspect "$CID" \
      --format '{{range $p,$c := .NetworkSettings.Ports}}{{if $c}}{{(index $c 0).HostIp}}|{{(index $c 0).HostPort}}|{{$p}}{{"\n"}}{{end}}{{end}}' 2>/dev/null \
      | grep '|8080/tcp' | head -1 || true)"
    if [[ -n "$MAP" ]]; then
      HIP="${MAP%%|*}"; HPORT="$(echo "$MAP" | cut -d'|' -f2)"
      [[ -z "$HIP" || "$HIP" == "0.0.0.0" ]] && HIP="127.0.0.1"
      UPSTREAM="$HIP:$HPORT"
    else
      # (b) no published port -> use the container's IP on its docker network
      CIP="$($DOCKER inspect "$CID" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' 2>/dev/null | awk '{print $1}')"
      [[ -n "$CIP" ]] && UPSTREAM="$CIP:8080"
      echo "!! No published host port found; using the container IP ($UPSTREAM)."
      echo "!! That IP can change on redeploy. For stability, add a Coolify Ports"
      echo "!! Mapping '127.0.0.1:8090:8080' and re-run:  sudo bash $0 $DOMAIN 127.0.0.1:8090"
    fi
  fi
fi
[[ -z "$UPSTREAM" ]] && { echo "ERROR: could not detect the dashboard container. Pass it explicitly, e.g.: sudo bash $0 $DOMAIN 127.0.0.1:8090"; exit 1; }

echo ">> Upstream (dashboard container): $UPSTREAM"

# --- 2. Sanity checks (do not abort; just warn) -------------------------------
if ss -tulpnH 2>/dev/null | grep -qE ':80 '; then
  echo "!! Something is already listening on :80 — nginx may fail to start. Check: sudo ss -tulpn | grep ':80 '"
fi
UPHOST="${UPSTREAM%%:*}"; UPPORT="${UPSTREAM##*:}"
if command -v curl >/dev/null 2>&1; then
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://${UPSTREAM}/" || true)"
  echo ">> Container health via ${UPSTREAM}: HTTP ${code} (200/302 = good; 000 = not reachable yet)"
fi

# --- 3. Install nginx if missing ---------------------------------------------
if ! command -v nginx >/dev/null 2>&1; then
  echo ">> Installing nginx..."
  apt-get update -y && apt-get install -y nginx
fi

# --- 4. Write the nginx site (port 80, SSE-friendly) --------------------------
AVAIL=/etc/nginx/sites-available/xui-dashboard.conf
ENABLED=/etc/nginx/sites-enabled/xui-dashboard.conf
for stale in /etc/nginx/sites-enabled/dashboard.conf "$ENABLED"; do
  [[ -L "$stale" && ! -e "$stale" ]] && { echo ">> Removing broken symlink: $stale"; rm -f "$stale"; }
done

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

        # Server-Sent Events (/api/stream, /public/stream): no buffering.
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
systemctl reload nginx 2>/dev/null || systemctl restart nginx || service nginx restart

echo ""
echo "=================================================================="
echo "nginx is now serving http://${DOMAIN}  ->  ${UPSTREAM}   (Xray :443 untouched)"
echo ""
echo "Finish in the Cloudflare dashboard (one-time):"
echo "  1. DNS: A record  ${DOMAIN}  ->  <this VPS public IP>   (Proxied / ORANGE cloud)"
echo "  2. SSL/TLS -> Overview -> set encryption mode to 'Flexible'"
echo "     (Cloudflare serves HTTPS to visitors and talks HTTP to :80 here.)"
echo ""
echo "Then open:  https://${DOMAIN}"
echo "If you see 502: the container isn't reachable on ${UPSTREAM} (check it's running)."
echo "=================================================================="
