# ⚡ 3x-ui Premium Dashboard

A modern, responsive, glassmorphic web dashboard for monitoring and managing your **3x-ui** (Xray-core) proxy servers. Designed with sleek animations, real-time metrics, active user count tracking, and zero-CORS proxy architecture.

---

## ✨ Features

- **🎨 Modern Glassmorphism UI**: High-end dark & light themes with smooth animations powered by GSAP, Three.js, and Vanta Globe.
- **📊 Total Consumption Meter**: Displays all-time cumulative bandwidth (Total Used, Total Remaining, and Quota %) with silky-smooth progress glide and glowing plasma flare.
- **📅 Monthly Period Cycle (1st to 30th/31st)**: Automatic calendar month period tracker (e.g. 1st – 31st Oct) with days-left countdown and cycle end dates.
- **🔄 Smart Traffic Baseline Engine**: Resolves 3x-ui's single-counter limitation by locally tracking monthly baseline usage on the 1st of each month in `traffic_history.json`, accurately separating Lifetime Total from Current Monthly Consumption.
- **👥 Live Connected Users / Device Count**: Displays active devices and connected client IPs from 3x-ui IP logs and active sessions.
- **📡 3-Node Interactive Latency Pipeline**: Visual packet travel across **Client ➔ VPS Proxy ➔ Internet** with individual hop latencies, jitter tracking, and quality badges.
- **⚡ Dynamic Network Speed Flow**: Realtime EMA-smoothed download and upload indicators featuring frequency-scaled directional arrow animations.
- **✨ Smart Consumption Flares**: Glowing white plasma flare radiating at the tip of the usage meter for limited quotas (automatically hidden for unlimited data).
- **📱 100% Mobile Responsive**: Generous card breathing room, spacious conduit padding in the 3-node latency pipeline, mobile bottom navigation, and vertical stats cards.
- **📊 Real-Time Server Metrics**: Live interactive charts for CPU, RAM, and inbound/outbound bandwidth consumption (Chart.js).
- **🔑 Native API Token & Session Auth**: Fully compatible with 3x-ui scoped Bearer tokens ([official docs](https://docs.sanaei.dev/docs/reference/api/api-tokens/)) and admin credentials.
- **🔒 Secure API Proxy**: Built-in backend proxy (Node.js Express / Cloudflare Functions) to eliminate CORS issues and protect your 3x-ui credentials.
- **⚡ Flexible Deployment**: Deploy via **Node.js (PM2)**, **Cloudflare Pages** (Serverless), or **Docker / Coolify**.

---

## 🛠️ Architecture

```text
[ Browser / Mobile Client ]
            │  (SSE Live Stream: Bandwidth, Users, Latency)
            ▼
[ Dashboard Proxy (Node.js :3000 / Cloudflare Functions) ]
            │  (Proxies requests with Bearer Token / Session Cookie)
            ▼
[ 3x-ui Panel (http://127.0.0.1:2053/web_base_path) ]
```

---

## 📋 Prerequisites

Before setting up the dashboard, ensure you have:
1. A running **3x-ui panel** (e.g. from [MHSanaei/3x-ui](https://github.com/MHSanaei/3x-ui)).
2. Your panel's **Full URL** (including `http://` or `https://`, port, and **Web Base Path** if configured).
3. Either:
   - Panel **Admin Username & Password**, or
   - Panel **API Token** (*3x-ui sidebar → Panel Settings → Security tab → API Token*).

> [!IMPORTANT]
> **Web Base Path Requirement:**  
> If your 3x-ui panel uses a custom URL path (e.g. `http://127.0.0.1:2053/secretpath/`), you **MUST** include the subpath in `PANEL_URL`:  
> `PANEL_URL="http://127.0.0.1:2053/secretpath"`  
> Omitting the web base path will result in `HTTP 404 Not Found`.

---

## 🚀 Installation & Deployment

### Method 1: VPS Setup with PM2 (Recommended)

Run the dashboard directly on your VPS as a persistent background process.

#### 1. Quick Install One-Liner
```bash
cd ~ && \
git clone https://github.com/ganidusandeepa/3x-ui-dashboard-.git ~/3x-ui-dashboard- && \
cd ~/3x-ui-dashboard- && \
npm install --production && \
cp .env.example .env
```

#### 2. Configure Environment Variables
Edit your `.env` file:
```bash
nano .env
```

```ini
# Full URL to your 3x-ui panel
PANEL_URL=http://127.0.0.1:2053

# Panel Authentication (Option A: API Token - Recommended)
PANEL_API_TOKEN=

# Panel Authentication (Option B: Admin Credentials)
PANEL_USERNAME=admin
PANEL_PASSWORD=your_password_here

# Port for this dashboard (Default: 3000)
PORT=3000

# Mask raw VPS IPs from client view for privacy
MASK_VPS_DETAILS=true

# Keep admin login disabled on client-facing dashboard
ADMIN_LOGIN_ENABLED=false
```

#### 3. Start with PM2
Launch the server using PM2 with the `--insecure-http-parser` argument (this prevents HTTP parsing errors when communicating with Go-based x-ui HTTP responses):

```bash
pm2 start server.js --name "3x-dashboard" --node-args="--insecure-http-parser" --update-env
pm2 save
pm2 startup
```

#### 4. Open Firewall Port
```bash
sudo ufw allow 3000/tcp
sudo ufw reload
```

Access your dashboard at `http://<YOUR_VPS_IP>:3000`.

---

### Method 2: Nginx Reverse Proxy with SSL (HTTPS Domain)

To access your dashboard securely at `https://dashboard.yourdomain.com`:

1. **Install Nginx & Certbot:**
   ```bash
   sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. **Create Nginx Configuration:**
   ```bash
   sudo nano /etc/nginx/sites-available/3x-dashboard
   ```

   ```nginx
   server {
       listen 80;
       server_name dashboard.yourdomain.com;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;

           # WebSocket and Server-Sent Events (SSE) support
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;

           # Disable buffering for live traffic meters
           proxy_buffering off;
           proxy_cache off;
           chunked_transfer_encoding off;
           proxy_read_timeout 86400s;
       }
   }
   ```

3. **Enable Site & Obtain SSL Certificate:**
   ```bash
   sudo ln -s /etc/nginx/sites-available/3x-dashboard /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl reload nginx
   sudo certbot --nginx -d dashboard.yourdomain.com
   ```

---

### Method 3: Cloudflare Pages (Serverless)

1. Fork or push this repository to your GitHub account.
2. In the **[Cloudflare Dashboard](https://dash.cloudflare.com/)**:
   - Navigate to **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
   - Select `3x-ui-dashboard-`.
3. **Build settings**: Leave both **Build command** and **Build output directory** empty.
4. **Environment Variables**: Add `PANEL_URL`, `PANEL_USERNAME`, and `PANEL_PASSWORD`.
5. Click **Save and Deploy**.

---

### Method 4: Docker / Coolify

```bash
docker run -d \
  --name 3x-ui-dashboard \
  --restart always \
  -p 3000:3000 \
  -e PANEL_URL="http://127.0.0.1:2053" \
  -e PANEL_USERNAME="admin" \
  -e PANEL_PASSWORD="password" \
  --network host \
  3x-ui-dashboard
```

---

## 🔄 Updating the Dashboard

To update your running installation to the latest version:

```bash
cd ~/3x-ui-dashboard-
git fetch origin main
git reset --hard origin/main
npm install --production
pm2 restart 3x-dashboard --node-args="--insecure-http-parser" --update-env
```

Or run the built-in update script:
```bash
bash update.sh
```

---

## 🛠️ Management Commands

| Action | Command |
|---|---|
| Check status | `pm2 status` |
| View live logs | `pm2 logs 3x-dashboard` |
| Restart dashboard | `pm2 restart 3x-dashboard --node-args="--insecure-http-parser"` |
| Stop dashboard | `pm2 stop 3x-dashboard` |
| Live monitor | `pm2 monit` |

---

## ❓ FAQ & Troubleshooting

### Why is `--insecure-http-parser` required?
3x-ui is built on Go's Gin framework, which can emit raw HTTP headers that Node.js 18+ strict HTTP parser rejects with `HPE_INVALID_VERSION`. Passing `--insecure-http-parser` enables Node's lenient HTTP parser, completely resolving this compatibility issue.

### Panel returns 404 Not Found
Ensure your `PANEL_URL` in `.env` includes the Web Base Path if one was configured in your 3x-ui panel settings (e.g. `http://127.0.0.1:2053/secretpath`).

---

## 📄 License

MIT License. Designed with ❤️ for the 3x-ui & Xray community.
