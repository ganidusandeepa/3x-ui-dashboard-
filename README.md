# ⚡ 3x-ui Premium Dashboard (API Upgrades & Fluid Animated Edition)

A modern, responsive, glassmorphic web dashboard for monitoring and managing your **3x-ui** (Xray-core) proxy servers. Designed with Apple-grade fluid animations, real-time metrics, active user count tracking, 3-node latency pipeline, modern odometer countdown, and a zero-CORS proxy architecture.

> **Target Branch**: `claude/3xui-dashboard-api-upgrades-qr4btq`

---

## ✨ Features

- **🎨 Modern Glassmorphism UI**: Dark & light themes with fluid animations powered by GSAP, Lenis momentum scroll, and optical specular glare.
- **📡 3-Node Interactive Latency Pipeline**: Visual packet trajectory and sonar shockwaves across **You (Device) ➔ Server (3x-ui VPS) ➔ Internet (Global Web)** with live ping test via the circular lightning bolt icon.
- **⏱️ Modern Linear Odometer Countdown**: Replaces boxy countdown cards with a sleek, rolling-digit flip odometer strip showing Days, Hours, Minutes, and Seconds until subscription expiry.
- **📊 Total Consumption Meter**: Displays cumulative bandwidth (Total Used, Download, Upload, Remaining Quota) with smooth progress gliding.
- **⚡ Dynamic Network Speed Flow**: Realtime EMA-smoothed download and upload indicators featuring frequency-scaled directional arrow animations.
- **📱 100% Mobile Responsive & Touch-Optimized**: Zero horizontal overflow on any phone (down to 320px). Features touch-tracking specular spotlights and tactile spring press feedback.
- **📋 One-Click Config & QR Codes**: Instant client configuration link copying (VLESS / VMess / Trojan) and automatic QR code generation.
- **👥 Live Connected Users**: Displays active devices and connected client IPs from 3x-ui IP logs.
- **🔑 Native API Token & Session Auth**: Fully compatible with 3x-ui scoped Bearer tokens and admin session credentials.
- **🔒 Built-in API Proxy**: Zero-CORS backend proxy prevents exposing 3x-ui admin ports to the public web.

---

## 📋 Prerequisites

Before installing, ensure you have:
1. A Linux VPS (Ubuntu 20.04/22.04/24.04, Debian 11/12, or CentOS).
2. A running **3x-ui panel** (e.g. [MHSanaei/3x-ui](https://github.com/MHSanaei/3x-ui)).
3. Your panel's **Full URL** (e.g. `http://127.0.0.1:2053` or including subpath like `http://127.0.0.1:2053/secretpath`).
4. Either your panel **Admin Credentials** (username & password) or **API Token** (*Panel Settings → Security → API Token*).

---

## 🚀 Installation Guide (Step-by-Step)

### Step 1: Install Node.js, Git, and PM2

Run the following commands on your VPS to install the required runtime tools:

```bash
# Update package list
sudo apt update && sudo apt install -y curl git

# Install Node.js 20.x LTS (Recommended)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2 globally for background process management
sudo npm install -g pm2
```

Verify your installation:
```bash
node -v   # Should output v18.x or v20.x
npm -v
pm2 -v
```

---

### Step 2: Clone this Branch

Clone the repository specifically on the `claude/3xui-dashboard-api-upgrades-qr4btq` branch:

```bash
cd ~
git clone -b claude/3xui-dashboard-api-upgrades-qr4btq https://github.com/ganidusandeepa/3x-ui-dashboard-.git ~/3x-ui-dashboard
cd ~/3x-ui-dashboard
```

*(If you already cloned the repo previously, simply switch to this branch):*
```bash
cd ~/3x-ui-dashboard
git fetch origin claude/3xui-dashboard-api-upgrades-qr4btq
git checkout claude/3xui-dashboard-api-upgrades-qr4btq
git pull origin claude/3xui-dashboard-api-upgrades-qr4btq
```

---

### Step 3: Install Dependencies

```bash
npm install --production
```

---

### Step 4: Configure Environment Variables

Create your `.env` configuration file from the template:

```bash
cp .env.example .env
nano .env
```

Set your panel details:

```ini
# ============================================================
# 3x-ui Dashboard Configuration
# ============================================================

# 1. Full URL to your local 3x-ui panel
# Note: If your panel is on the same VPS, use http://127.0.0.1:2053
# IMPORTANT: If your panel has a Web Base Path (e.g. /mybase/), append it!
PANEL_URL=http://127.0.0.1:2053

# 2. Authentication Option A: Admin Credentials
PANEL_USERNAME=admin
PANEL_PASSWORD=your_password_here

# 3. Authentication Option B: Bearer API Token (Recommended if enabled in 3x-ui)
# PANEL_API_TOKEN=your_api_token_here

# 4. Port for this dashboard web server (Default: 8080)
PORT=8080
```

> [!IMPORTANT]
> **Web Base Path Requirement:**  
> If your 3x-ui panel uses a custom URL path (e.g. `http://127.0.0.1:2053/secretpath/`), you **MUST** include the subpath in `PANEL_URL`:  
> `PANEL_URL="http://127.0.0.1:2053/secretpath"`  
> Omitting the web base path will result in `HTTP 404 Not Found`.

Save and exit `nano` by pressing `Ctrl + O`, `Enter`, then `Ctrl + X`.

---

### Step 5: Start the Dashboard with PM2

Launch the server using PM2 with the `--insecure-http-parser` flag:

```bash
pm2 start server.js --name "3x-dashboard" --node-args="--insecure-http-parser" --update-env
pm2 save
pm2 startup
```

*(Copy and run the `sudo env PATH=...` command that `pm2 startup` prints if prompted, to ensure PM2 restarts automatically on VPS reboot).*

---

### Step 6: Open the Firewall Port

Allow access to the dashboard port (default `8080`):

```bash
sudo ufw allow 8080/tcp
sudo ufw reload
```

---

## 💻 How to Use the Dashboard

Once started, open your web browser and navigate to:
```text
http://<YOUR_VPS_IP>:8080
```

### 1. Client View (For Users & Customers)

- **Manual Login**: Enter client **Email** or **Client ID / UUID** into the login field and click **Check Traffic**.
- **Instant Direct URL**: Share a pre-filled direct link with your users so they bypass the login screen immediately:
  ```text
  http://<YOUR_VPS_IP>:8080/?id=client@example.com
  # or by UUID:
  http://<YOUR_VPS_IP>:8080/?id=8f6a9170-1f20-4180-879e-4361e2b5e297
  ```
- **What Clients Can Do**:
  - **Check Usage**: View total used, download, upload, and remaining quota.
  - **Expiry Countdown**: Check days, hours, and minutes remaining with the animated odometer.
  - **Latency Test**: Click the **circular lightning bolt icon** (`⚡`) on the latency card to execute a live 3-node ping test from their device through the VPS to the global internet.
  - **Copy Config**: Copy their VLESS / VMess / Trojan configuration URI or subscription link with one click.
  - **QR Code**: Scan the displayed QR code directly with V2RayNG, Shadowrocket, Streisand, or Sing-box.

---

### 2. Admin View (For Server Owners)

- **Accessing Admin**: Click the **Admin** tab on the login screen or navigate directly to:
  ```text
  http://<YOUR_VPS_IP>:8080/?admin=1
  ```
- **Sign In**: Enter your panel admin username & password.
- **Features in Admin Portal**:
  - **Overview**: Real-time charts for CPU, RAM, and inbound network traffic.
  - **Inbounds**: View all active server ports, protocols, and client counts.
  - **Clients**: Search, inspect, edit, or create new clients.
  - **System**: Monitor server health, live users, and Xray core status.

---

## 🔄 Updating to the Latest Version

Whenever updates or new features are pushed to this branch, run this single update command on your VPS:

```bash
cd ~/3x-ui-dashboard && \
git fetch origin claude/3xui-dashboard-api-upgrades-qr4btq && \
git reset --hard origin/claude/3xui-dashboard-api-upgrades-qr4btq && \
npm install --production && \
pm2 restart 3x-dashboard --node-args="--insecure-http-parser" --update-env
```

---

## 🛠️ Management Commands

| Action | Command |
|---|---|
| **Check Status** | `pm2 status` |
| **View Live Logs** | `pm2 logs 3x-dashboard` |
| **Restart Server** | `pm2 restart 3x-dashboard --node-args="--insecure-http-parser" --update-env` |
| **Stop Server** | `pm2 stop 3x-dashboard` |
| **Start Server** | `pm2 start 3x-dashboard --node-args="--insecure-http-parser"` |
| **Monitor CPU/RAM** | `pm2 monit` |

---

## 🌐 Optional: Nginx Reverse Proxy with Free SSL (HTTPS)

To serve the dashboard on a custom domain (e.g. `https://sub.yourdomain.com`) with automated HTTPS:

1. **Install Nginx & Certbot**:
   ```bash
   sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. **Create Nginx Configuration**:
   ```bash
   sudo nano /etc/nginx/sites-available/3x-dashboard
   ```

   Paste the configuration:
   ```nginx
   server {
       listen 80;
       server_name sub.yourdomain.com;

       location / {
           proxy_pass http://127.0.0.1:8080;
           proxy_http_version 1.1;

           # Server-Sent Events (SSE) & WebSocket compatibility
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;

           # Critical: Disable buffering for realtime SSE streams
           proxy_buffering off;
           proxy_cache off;
           chunked_transfer_encoding off;
           proxy_read_timeout 86400s;
       }
   }
   ```

3. **Enable Site & Activate SSL**:
   ```bash
   sudo ln -s /etc/nginx/sites-available/3x-dashboard /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   sudo certbot --nginx -d sub.yourdomain.com
   ```

---

## ❓ FAQ & Troubleshooting

### Q1: Why is `--node-args="--insecure-http-parser"` necessary?
The 3x-ui panel backend is built with Go's Gin framework. In some releases, Gin returns raw HTTP status strings or headers that modern Node.js (18+) strict HTTP parser rejects with `HPE_INVALID_VERSION`. Passing `--insecure-http-parser` switches Node to lenient HTTP parsing mode, guaranteeing stable, uninterrupted communication with 3x-ui.

### Q2: Dashboard says "Panel returned 404" or fails to load data
Make sure `PANEL_URL` in `.env` includes the Web Base Path if one was configured in your 3x-ui settings (e.g., `http://127.0.0.1:2053/mybase`).

### Q3: How do I change the dashboard port?
Edit `PORT=XXXX` in `.env` (e.g. `PORT=3000`), then restart PM2:
```bash
pm2 restart 3x-dashboard --update-env
```
Remember to open the new port in your firewall (`sudo ufw allow XXXX/tcp`).

---

## 📄 License

MIT License. Designed with ❤️ for the 3x-ui & Xray community.
