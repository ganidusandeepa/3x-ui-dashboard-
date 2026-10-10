# 🚀 3x-ui Premium Dashboard — Complete Setup Guide

A complete, step-by-step guide to installing, configuring, securing, and maintaining the **3x-ui Premium Dashboard** on your Linux VPS.

---

## 📑 Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Quick Installation (Automated)](#2-quick-installation-automated)
3. [Manual Installation (Step-by-Step)](#3-manual-installation-step-by-step)
   - [Step 1: Install Node.js and PM2](#step-1-install-nodejs-and-pm2)
   - [Step 2: Clone Repository & Switch Branch](#step-2-clone-repository--switch-branch)
   - [Step 3: Install Dependencies](#step-3-install-dependencies)
   - [Step 4: Configure Environment Variables (.env)](#step-4-configure-environment-variables-env)
   - [Step 5: Start with PM2](#step-5-start-with-pm2)
   - [Step 6: Configure Firewall](#step-6-configure-firewall)
4. [Optional: Domain, Nginx Reverse Proxy & SSL](#4-optional-domain-nginx-reverse-proxy--ssl)
5. [Useful PM2 Management Commands](#5-useful-pm2-management-commands)
6. [Updating the Dashboard](#6-updating-the-dashboard)
7. [Troubleshooting & FAQ](#7-troubleshooting--faq)

---

## 1. Prerequisites

Before installing the dashboard, make sure you have:

- A **Linux VPS** (Ubuntu 20.04/22.04/24.04 or Debian 11/12 recommended).
- An active **3x-ui panel** installed and running on the VPS or another server.
- Root or `sudo` access to your server.
- The **Panel URL** (e.g. `http://127.0.0.1:2053` or `https://your-domain.com:2053/base_path`).
- Either:
  - Panel **Admin Username & Password**, or
  - Panel **API Token** (*3x-ui Settings → Security → API Token → Generate*).

---

## 2. Quick Installation (Automated)

Run the following one-liner on your VPS terminal:

```bash
cd ~ && \
git clone -b claude/3xui-dashboard-api-upgrades-qr4btq https://github.com/ganidusandeepa/3x-ui-dashboard-.git ~/3x-ui-dashboard- && \
cd ~/3x-ui-dashboard- && \
npm install && \
cp .env.example .env
```

After running the command above, edit your configuration:
```bash
nano .env
```
Fill in your panel credentials, save (`Ctrl + O`, `Enter`, `Ctrl + X`), then start the app:
```bash
pm2 start server.js --name "3x-dashboard" --node-args="--insecure-http-parser"
pm2 save
pm2 startup
```

---

## 3. Manual Installation (Step-by-Step)

### Step 1: Install Node.js and PM2

If Node.js (v18+) and PM2 are not installed on your VPS, install them:

```bash
# Update package lists
sudo apt update && sudo apt install -y curl git

# Install Node.js LTS (v20)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node -v   # Should output v20.x or higher
npm -v

# Install PM2 globally to manage background execution
sudo npm install -g pm2
```

---

### Step 2: Clone Repository & Switch Branch

Clone the repository and check out the `claude/3xui-dashboard-api-upgrades-qr4btq` branch:

```bash
# Clone directly into ~/3x-ui-dashboard-
git clone -b claude/3xui-dashboard-api-upgrades-qr4btq https://github.com/ganidusandeepa/3x-ui-dashboard-.git ~/3x-ui-dashboard-

# Navigate into the project folder
cd ~/3x-ui-dashboard-
```

> **If you already have the repository cloned:**
> ```bash
> cd ~/3x-ui-dashboard-
> git fetch origin claude/3xui-dashboard-api-upgrades-qr4btq
> git checkout -B claude/3xui-dashboard-api-upgrades-qr4btq origin/claude/3xui-dashboard-api-upgrades-qr4btq
> ```

---

### Step 3: Install Dependencies

```bash
npm install --production
```

---

### Step 4: Configure Environment Variables (.env)

Create and edit the `.env` configuration file:

```bash
cp .env.example .env
nano .env
```

Configure the following parameters according to your setup:

```ini
# ========================================================
# 3x-ui Dashboard Configuration
# ========================================================

# The full URL to your 3x-ui panel.
# If running on the same VPS, use http://127.0.0.1:<PORT>
# IMPORTANT: Include web base path if configured (e.g. http://127.0.0.1:2053/mysecretpath)
PANEL_URL=http://127.0.0.1:2053

# Panel Authentication (Option A: API Bearer Token - Recommended)
# Obtain from: 3x-ui -> Settings -> Security -> API Token
PANEL_API_TOKEN=

# Panel Authentication (Option B: Admin Credentials)
PANEL_USERNAME=admin
PANEL_PASSWORD=your_password_here

# Port for this dashboard (Default: 3000)
PORT=3000

# Public domain shown in client configs (e.g. vless:// links)
# If left empty, auto-detects from host header or localhost
PUBLIC_DOMAIN=

# Privacy: Set to true to mask raw server IPs from public client view
MASK_VPS_DETAILS=true

# Admin Login on Dashboard (set to true if you want admin auth enabled)
ADMIN_LOGIN_ENABLED=false
```

Save and exit nano:
- Press `Ctrl + O` then `Enter` to save.
- Press `Ctrl + X` to exit.

---

### Step 5: Start with PM2

Start the dashboard using PM2 with the `--insecure-http-parser` argument (this prevents HTTP parse errors when communicating with Go-based x-ui HTTP responses):

```bash
pm2 start server.js --name "3x-dashboard" --node-args="--insecure-http-parser" --update-env
```

Save the PM2 process list and configure auto-start on VPS boot:

```bash
pm2 save
pm2 startup
```
*(If `pm2 startup` outputs a `sudo env PATH=...` command, copy and run it as instructed).*

---

### Step 6: Configure Firewall

Allow the dashboard port through your firewall (e.g. port 3000):

```bash
# UFW (Ubuntu/Debian)
sudo ufw allow 3000/tcp
sudo ufw reload
```

Now open your web browser and visit:
```text
http://<YOUR_VPS_IP>:3000
```

---

## 4. Optional: Domain, Nginx Reverse Proxy & SSL

To access your dashboard securely at `https://dashboard.yourdomain.com`:

### 1. Install Nginx and Certbot
```bash
sudo apt install -y nginx certbot python3-certbot-nginx
```

### 2. Create Nginx Configuration
```bash
sudo nano /etc/nginx/sites-available/3x-dashboard
```

Paste the following configuration (replace `dashboard.yourdomain.com` with your real domain):

```nginx
server {
    listen 80;
    server_name dashboard.yourdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # WebSocket and SSE Support
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Disable buffering for live Server-Sent Events (SSE)
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;
        proxy_read_timeout 86400s;
    }
}
```

### 3. Enable the Site & Reload Nginx
```bash
sudo ln -s /etc/nginx/sites-available/3x-dashboard /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### 4. Obtain Free SSL Certificate
```bash
sudo certbot --nginx -d dashboard.yourdomain.com
```

Now your dashboard is live with HTTPS at `https://dashboard.yourdomain.com`!

---

## 5. Useful PM2 Management Commands

| Action | Command |
|---|---|
| **View Status** | `pm2 status` |
| **View Live Logs** | `pm2 logs 3x-dashboard` |
| **Restart Dashboard** | `pm2 restart 3x-dashboard --node-args="--insecure-http-parser"` |
| **Stop Dashboard** | `pm2 stop 3x-dashboard` |
| **View Metrics** | `pm2 monit` |

---

## 6. Updating the Dashboard

To pull future updates without losing your `.env` configuration:

```bash
cd ~/3x-ui-dashboard-
git fetch origin claude/3xui-dashboard-api-upgrades-qr4btq
git reset --hard origin/claude/3xui-dashboard-api-upgrades-qr4btq
npm install --production
pm2 restart 3x-dashboard --node-args="--insecure-http-parser" --update-env
```

Or run the built-in update script:
```bash
bash update.sh
```

---

## 7. Troubleshooting & FAQ

### 1. Panel returns 404 Not Found
- Check if your 3x-ui panel has a **Web Base Path** configured in 3x-ui settings (e.g. `/xui`).
- If it does, ensure `PANEL_URL` in `.env` includes that base path:
  ```ini
  PANEL_URL=http://127.0.0.1:2053/xui
  ```

### 2. HPE_INVALID_VERSION Error
- Always launch Node.js / PM2 with `--node-args="--insecure-http-parser"`. This allows Node's HTTP parser to accept responses from Go-based x-ui servers without crashing.

### 3. Port already in use (EADDRINUSE)
- Change `PORT=3000` in `.env` to another port (e.g. `PORT=8085`) and run `pm2 restart 3x-dashboard --update-env`.

### 4. Client countdown / plan disappearing after load
- The `claude/3xui-dashboard-api-upgrades-qr4btq` branch includes the fix where `expiryTime` is merged into the live SSE stream, keeping the countdown clock and plan expiration active continuously.
