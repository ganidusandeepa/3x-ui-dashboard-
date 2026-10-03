#!/usr/bin/env bash
set -e

echo "========================================="
echo "  Upgrading 3x-ui Dashboard from GitHub  "
echo "========================================="

# Navigate to script directory
cd "$(dirname "$0")"

# Pull latest code
echo "--> Pulling latest changes from main branch..."
git pull origin main

# Install any updated dependencies
echo "--> Updating dependencies..."
npm install

# Restart PM2 process with updated environment
echo "--> Restarting dashboard in PM2..."
pm2 restart 3x-dashboard --update-env

echo "========================================="
echo "  Upgrade Complete! Showing live logs:   "
echo "========================================="
pm2 logs 3x-dashboard --lines 15
