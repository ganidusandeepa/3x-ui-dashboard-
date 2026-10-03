# ⚡ 3x-ui Premium Dashboard

A modern, responsive, and glassmorphic web dashboard for monitoring and managing your **3x-ui** (Xray-core) proxy servers. Designed with sleek animations, real-time metrics, and zero-CORS proxy architecture.

---

## ✨ Features

- **🎨 Modern Glassmorphism UI**: High-end dark theme with smooth animations powered by GSAP and Three.js.
- **📱 100% Mobile Responsive**: Dedicated mobile bottom navigation bar and touch-friendly cards.
- **📊 Real-Time Metrics**: Live interactive charts for CPU, RAM, and inbound/outbound bandwidth consumption (Chart.js).
- **🔒 Secure API Proxy**: Built-in backend proxy (Node.js / Cloudflare Functions) to eliminate CORS issues and protect your 3x-ui credentials.
- **⚡ Flexible Deployment**: Deploy in minutes to **Cloudflare Pages** (Serverless), **Docker / Coolify**, or directly via **Node.js**.

---

## 🛠️ Architecture

```text
[ Browser / Mobile Client ]
            │
            ▼
[ Dashboard Proxy (Cloudflare Functions / Node.js) ]
            │  (Proxies requests & handles session cookies)
            ▼
[ 3x-ui Panel API (http://your-server:2053) ]
```

---

## 📋 Prerequisites

Before setting up the dashboard, ensure you have:
1. A running **3x-ui panel** (e.g. from [MHSanaei/3x-ui](https://github.com/MHSanaei/3x-ui)).
2. Your panel's **IP address / Domain** and **Port** (default: `2053`).
3. An **API Token** from 3x-ui (**Panel Settings → API Token** / **API Tokens**) — *Recommended*, or your admin username and password.

---

## 🚀 Deployment Methods

Choose the deployment method that fits your setup:

### Method 1: Cloudflare Pages (Recommended — Fast & Free)

Cloudflare Pages hosts the frontend and executes the API proxy on Cloudflare Edge with zero maintenance.

1. **Fork or Push** this repository to your GitHub account.
2. In the **[Cloudflare Dashboard](https://dash.cloudflare.com/)**:
   - Navigate to **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
   - Select your repository (`3x-ui-dashboard-`).
3. **Build Configuration**:
   - **Framework preset**: None
   - **Build command**: *(leave empty)*
   - **Build output directory**: *(leave empty)*
4. **Configure Environment Variables**:
   - Go to **Settings** → **Variables and Secrets** → **Environment Variables** (Production).
   - Add the following variables:
     | Variable | Description | Example |
     | :--- | :--- | :--- |
     | `PANEL_URL` | Base URL of your 3x-ui panel | `http://1.2.3.4:2053` or `https://panel.yourdomain.com` |
     | `PANEL_API_TOKEN` | *(Recommended)* 3x-ui API Token (Settings → API Token) | `your_api_token_here` |
     | `PANEL_USERNAME` | *(Alternative)* 3x-ui admin username | `admin` |
     | `PANEL_PASSWORD` | *(Alternative)* 3x-ui admin password | `your_password` |
5. **Deploy**:
   - Click **Save and Deploy**.
   - Cloudflare will automatically build the site and provide you with a `.pages.dev` URL.

---

### Method 2: Docker / Coolify (On the Same VPS as 3x-ui)

If you want to run the dashboard on the same VPS hosting your 3x-ui panel, use Docker or Coolify.

#### Running with Docker CLI:
```bash
# Build the Docker image
docker build -t 3x-ui-dashboard .

# Run container (uses host networking to communicate with local 3x-ui)
docker run -d \
  --name 3x-ui-dashboard \
  --restart unless-stopped \
  --network host \
  -e PANEL_URL="http://127.0.0.1:2053" \
  -e PANEL_API_TOKEN="your_3xui_api_token" \
  -e PANEL_PASSWORD="dashboard_admin_password" \
  -e PORT="8080" \
  3x-ui-dashboard
```

#### Running with Coolify:
1. Go to **Coolify** → **New Resource** → **Application** → **Public/Private Repository**.
2. Select this repository and the `main` branch.
3. Coolify will auto-detect the `Dockerfile`.
4. Add the required environment variables in the Coolify UI:
   - `PANEL_URL`: `http://127.0.0.1:2053` *(or container name if bridged: `http://3x-ui:2053`)*
   - `PANEL_API_TOKEN`: your 3x-ui API token (or `PANEL_USERNAME` & `PANEL_PASSWORD`)
   - `PANEL_PASSWORD`: dashboard admin password
   - `PORT`: `8080`
5. Map host port `8080` (or a custom port like `8090:8080` if 8080 is taken).
6. Click **Deploy**.

---

### Method 3: Local or VPS Setup with Node.js

1. **Clone the repository:**
   ```bash
   git clone https://github.com/ganidusandeepa/3x-ui-dashboard-.git
   cd 3x-ui-dashboard-
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set Environment Variables:**
   - **Linux / macOS:**
     ```bash
     export PANEL_URL="http://127.0.0.1:2083"
     export PANEL_API_TOKEN="your_3xui_api_token"
     export PORT=8080
     ```
   - **Windows (PowerShell):**
     ```powershell
     $env:PANEL_URL="http://127.0.0.1:2083"
     $env:PANEL_API_TOKEN="your_3xui_api_token"
     $env:PORT="8080"
     ```

4. **Start the application:**
   ```bash
   npm start
   ```

5. Open your browser at `http://localhost:8080`.

---

## ⚙️ Environment Variables Reference

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `PANEL_URL` | **Yes** | `http://127.0.0.1:2053` | Address and port of your 3x-ui panel |
| `PANEL_API_TOKEN` | **Recommended** | — | 3x-ui API Token (from **Settings → API Token**). Directly authorizes requests with `Authorization: Bearer <token>`. |
| `PANEL_USERNAME` | Optional | `admin` | Fallback 3x-ui admin username (if not using API Token) |
| `PANEL_PASSWORD` | Optional | `password` | Fallback 3x-ui admin password (or dashboard admin password) |
| `PORT` | No | `8080` | Port for the Node.js dashboard server |
| `METRICS_INTERVAL_MS` | No | `2000` | Polling frequency for server metrics (ms) |
| `METRICS_CACHE_TTL` | No | `1000` | In-memory cache duration for metrics |

---

## 🔍 Troubleshooting

### 1. Panel Connection Error / 502 Bad Gateway
- Ensure `PANEL_URL` is reachable from the server running the dashboard.
- If running in Docker on the same machine as 3x-ui, use `--network host` and `PANEL_URL=http://127.0.0.1:2053`.
- Verify the 3x-ui port (default `2053`) is not blocked by your cloud firewall (e.g. AWS Security Group, Oracle Cloud Ingress rules, or `ufw`).

### 2. Login Failed / Unauthorized
- Verify that `PANEL_USERNAME` and `PANEL_PASSWORD` match your 3x-ui credentials.
- If you configured a custom web base path in 3x-ui (e.g., `/myadmin/`), append it to `PANEL_URL` (e.g., `http://1.2.3.4:2053/myadmin/`).

---

## 📄 License

This project is licensed under the [GNU General Public License v3.0](LICENSE).
