#!/bin/bash
set -e

echo "=== 3x-ui Dashboard Auto-Setup on VPS ==="
echo ""

echo "Step 1: Fix broken nginx symlink and restart..."
sudo rm -f /etc/nginx/sites-enabled/dashboard.conf
sudo systemctl start nginx 2>/dev/null || true
sudo systemctl status nginx --no-pager | head -10
echo "✓ nginx restarted"

echo ""
echo "Step 2: Clone/update dashboard repository..."
if [ ! -d /opt/3x-ui-dashboard ]; then
  cd /opt
  sudo git clone -b claude/3xui-dashboard-api-upgrades-qr4btq https://github.com/ganidusandeepa/3x-ui-dashboard-.git 3x-ui-dashboard
  sudo chown -R $(whoami):$(whoami) 3x-ui-dashboard
else
  cd /opt/3x-ui-dashboard
  sudo git fetch origin
  sudo git checkout claude/3xui-dashboard-api-upgrades-qr4btq
  sudo git pull origin claude/3xui-dashboard-api-upgrades-qr4btq
fi
echo "✓ Repository ready"

echo ""
echo "Step 3: Check Coolify dashboard container..."
CONTAINER=$(sudo docker ps --filter "name=dashboard" --format "{{.ID}}" 2>/dev/null | head -1)
if [ -n "$CONTAINER" ]; then
  echo "✓ Dashboard container running: $CONTAINER"
  sudo docker ps --filter "name=dashboard" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
else
  echo "⚠ Dashboard container not found - Coolify may still be deploying"
  echo "  Make sure Coolify has deployed successfully and container is on 127.0.0.1:8090"
fi

echo ""
echo "Step 4: Verify DNS (vps.trackydev.site)..."
if command -v dig >/dev/null 2>&1; then
  VPS_IP=$(dig +short vps.trackydev.site @8.8.8.8 | tail -1)
  if [ -n "$VPS_IP" ]; then
    echo "✓ DNS configured: vps.trackydev.site -> $VPS_IP"
  else
    echo "⚠ DNS not yet configured for vps.trackydev.site"
    echo "  Add A record in Cloudflare: vps.trackydev.site -> your VPS IP (grey cloud)"
  fi
else
  echo "ℹ dig not available, skipping DNS check"
fi

echo ""
echo "Step 5: Run automated nginx + certbot setup..."
cd /opt/3x-ui-dashboard
sudo bash deploy/setup-dashboard.sh vps.trackydev.site 127.0.0.1:8090

echo ""
echo "======================================="
echo "✓ SETUP COMPLETE!"
echo "======================================="
echo ""
echo "Your dashboard should be live at:"
echo "  https://vps.trackydev.site"
echo ""
echo "Troubleshooting:"
echo "  • If you see '502 Bad Gateway', wait 2-3 mins for Coolify to deploy"
echo "  • Check: curl -v http://127.0.0.1:8090/"
echo "  • Logs: docker logs \$(docker ps --filter 'name=dashboard' -q 2>/dev/null || echo 'dashboard-container')"
echo ""
