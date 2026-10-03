# ⚡ 3x-ui Premium Dashboard

A modern, responsive, and glassmorphic web dashboard for monitoring and managing your **3x-ui** (Xray-core) proxy servers. Designed with sleek animations, real-time metrics, and zero-CORS proxy architecture.

---

## ✨ Features

- **🎨 Modern Glassmorphism UI**: High-end dark theme with smooth animations powered by GSAP and Three.js.
- **📱 100% Mobile Responsive**: Dedicated mobile bottom navigation bar and touch-friendly cards.
- **📊 Real-Time Metrics**: Live interactive charts for CPU, RAM, and inbound/outbound bandwidth consumption (Chart.js).
- **🔑 Native API Token Support**: Fully compatible with 3x-ui scoped Bearer tokens ([official docs](https://docs.sanaei.dev/docs/reference/api/api-tokens/)).
- **🔒 Secure API Proxy**: Built-in backend proxy (Node.js / Cloudflare Functions) to eliminate CORS issues and protect your 3x-ui credentials.
- **⚡ Flexible Deployment**: Deploy in minutes to **Cloudflare Pages** (Serverless), **Docker / Coolify**, or directly via **Node.js (PM2)**.

---

## 🛠️ Architecture

```text
[ Browser / Mobile Client ]
            │
            ▼
[ Dashboard Proxy (Node.js :8080 / Cloudflare Functions) ]
            │  (Proxies requests with Bearer Token / Session)
            ▼
[ 3x-ui Panel (https://your-domain:2083/web_base_path) ]
```

---

## 📋 Prerequisites

Before setting up the dashboard, ensure you have:
1. A running **3x-ui panel** (e.g. from [MHSanaei/3x-ui](https://github.com/MHSanaei/3x-ui)).
2. Your panel's **Full URL** (including `http://` or `https://`, port, and **Web Base Path** if configured).
3. An **API Token** from 3x-ui:
   - In 3x-ui sidebar: **Panel Settings** → **Security** tab → **API Token**.
   - Click **Generate Token** / **Add Token** (choose `admin` scope) and copy the generated token.

> [!IMPORTANT]
> **Web Base Path Requirement:**  
> If your 3x-ui panel uses a custom URL path (e.g. `https://trackydev.site:2083/ghc4QE4Ha6kFxHHIIB/`), you **MUST** include the subpath in `PANEL_URL`:  
> `PANEL_URL="https://trackydev.site:2083/ghc4QE4Ha6kFxHHIIB"`  
> Omitting the web base path will result in `HTTP 404 Not Found`.

---

## 🚀 Deployment Methods

### Method 1: VPS Setup with PM2 (Recommended)

Run the dashboard directly on your VPS as a persistent background process.

1. **Clone the repository and install dependencies:**
   ```bash
   cd /var/www || cd ~
   git clone https://github.com/ganidusandeepa/3x-ui-dashboard-.git
   cd 3x-ui-dashboard-
   npm install
   ```

2. **Start the dashboard with PM2:**
   ```bash
   PANEL_URL="https://YOUR_DOMAIN:2083/YOUR_BASE_PATH" \
   PANEL_API_TOKEN="YOUR_3XUI_API_TOKEN" \
   PORT="8080" \
   pm2 start server.js --name "3x-dashboard" --node-args="--insecure-http-parser"
   ```

3. **Enable auto-start on VPS boot:**
   ```bash
   pm2 save
   pm2 startup
   ```

4. **Open port 8080 on your firewall:**
   ```bash
   sudo ufw allow 8080/tcp
   sudo ufw reload
   ```

5. Access your dashboard at `http://<YOUR_VPS_IP>:8080`.

---

### Method 2: Docker / Coolify

#### Running with Docker CLI:
```bash
# Build the image
docker build -t 3x-ui-dashboard .

# Run container
docker run -d \
  --name 3x-ui-dashboard \
  --restart always \
  -p 8080:8080 \
  -e PANEL_URL="https://YOUR_DOMAIN:2083/YOUR_BASE_PATH" \
  -e PANEL_API_TOKEN="YOUR_3XUI_API_TOKEN" \
  -e PORT="8080" \
  3x-ui-dashboard
```

#### Running with Coolify:
1. Go to **Coolify** → **New Resource** → **Application** → **Public/Private Repository**.
2. Select this repository and the `main` branch.
3. Add the required environment variables:
   - `PANEL_URL`: `https://YOUR_DOMAIN:2083/YOUR_BASE_PATH`
   - `PANEL_API_TOKEN`: your 3x-ui API token
   - `PORT`: `8080`
4. Set Port Mapping to `8080` and click **Deploy**.

---

### Method 3: Cloudflare Pages (Serverless)

1. Connect your repository to **Cloudflare Pages** (Workers & Pages → Create → Pages).
2. Leave **Build command** and **Build output directory** blank.
3. In **Settings → Variables and Secrets**, set:
   - `PANEL_URL`: `https://YOUR_DOMAIN:2083/YOUR_BASE_PATH`
   - `PANEL_API_TOKEN`: your 3x-ui API token
4. Deploy. Cloudflare Functions will handle the proxy automatically at the edge.

---

## 🔄 One-Command Upgrade

Whenever updates are pushed to GitHub, you can upgrade your dashboard in 1 second:

```bash
cd ~/3x-ui-dashboard- || cd /var/www/3x-ui-dashboard-
./update.sh
```

---

## ⚙️ Environment Variables Reference

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `PANEL_URL` | **Yes** | — | Full URL to 3x-ui, including protocol, port, and Web Base Path (e.g. `https://trackydev.site:2083/ghc4QE4Ha6kFxHHIIB`) |
| `PANEL_API_TOKEN` | **Recommended** | — | 3x-ui API Token (from **Settings → Security → API Token**). Authenticates with `Authorization: Bearer <token>`. |
| `PANEL_USERNAME` | Optional | `admin` | Fallback 3x-ui admin username (if not using API Token) |
| `PANEL_PASSWORD` | Optional | `password` | Fallback 3x-ui admin password (or dashboard admin password) |
| `PORT` | No | `8080` | Port for the dashboard web server |
| `METRICS_INTERVAL_MS` | No | `3000` | Frequency for server metrics SSE updates (ms) |
| `METRICS_CACHE_TTL` | No | `3` | Cache duration for metrics in seconds |

---

## 🔍 Troubleshooting

### 1. HTTP 404 Not Found on API Calls
* **Cause**: Your 3x-ui panel has a **Web Base Path** configured in Panel Settings, but it was omitted from `PANEL_URL`.
* **Fix**: Check the exact URL you use in your browser. If it looks like `https://domain:2083/subpath/panel/settings`, your `PANEL_URL` must be `https://domain:2083/subpath`.

### 2. `fetch failed` or `HPE_INVALID_VERSION`
* **Cause**: Protocol mismatch (using `http://` on an `https://` port) or non-standard HTTP header response.
* **Fix**: Ensure your `PANEL_URL` starts with `https://` if using a domain with SSL. The dashboard includes a lenient native HTTP parser to prevent version check errors.

### 3. Login / Authentication Failed
* **Cause**: Invalid API Token or missing permissions.
* **Fix**: Generate a new API Token in 3x-ui under **Settings → Security → API Token** with `admin` scope and update `PANEL_API_TOKEN`.

---

## 📄 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
