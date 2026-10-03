#!/usr/bin/env bash
set -e

echo "========================================="
echo "  Upgrading 3x-ui Dashboard from GitHub  "
echo "========================================="

cd "$(dirname "$0")"

echo "--> Pulling latest changes from main branch..."
git pull origin main

echo "--> Updating dependencies..."
npm install

echo "--> Restarting dashboard in PM2 with lenient parser..."
pm2 restart 3x-dashboard --node-args="--insecure-http-parser" --update-env

echo "========================================="
echo "  Upgrade Complete! Showing live logs:   "
echo "========================================="
pm2 logs 3x-dashboard --lines 15
