#!/bin/sh
set -e

echo "========================================="
echo "  Upgrading 3x-ui Dashboard from GitHub  "
echo "========================================="

# Move to the script's directory
cd "$(dirname "$0")"
echo "Working directory: $(pwd)"

echo "--> Fetching and resetting to latest origin/main..."
git fetch origin main
git reset --hard origin/main

echo "--> Removing any corrupted traffic cache..."
rm -f traffic_history.json

echo "--> Installing dependencies if required..."
npm install --production --no-audit || true

echo "--> Restarting dashboard in PM2..."
if command -v pm2 >/dev/null 2>&1; then
    pm2 restart 3x-dashboard --node-args="--insecure-http-parser" --update-env || pm2 restart server --update-env || pm2 start server.js --name 3x-dashboard --node-args="--insecure-http-parser"
    pm2 save || true
else
    echo "PM2 not found in PATH, skipping PM2 restart."
fi

echo "========================================="
echo "  Upgrade Complete! Testing version...   "
echo "========================================="
if command -v curl >/dev/null 2>&1; then
    curl -s http://127.0.0.1:3000/api/version || echo ""
fi
echo ""
echo "Dashboard is updated successfully!"
