# 3x-ui Premium Dashboard

A modern, animated, and mobile-responsive dashboard for managing your 3x-ui panel. Built with GSAP, Three.js, and Chart.js.

![Dashboard Preview](https://raw.githubusercontent.com/iamhelitha/3xui-api-client/main/preview.png) *(Placeholder for your preview)*

## Features
- **Modern UI**: Glassmorphism aesthetic with dark mode.
- **Mobile First**: Bottom navigation and optimized cards for phones.
- **Real-time Metrics**: Dynamic charts for CPU, RAM, and Traffic.
- **Proxy Server**: Secure Node.js backend to communicate with your panel.

## ☁️ Cloudflare Deployment (Recommended)

This dashboard is ready to be hosted on **Cloudflare Pages**.

1. **Upload to GitHub**: Push this folder to your GitHub.
2. **Setup Cloudflare Pages**:
   - Go to the Cloudflare Dashboard -> Workers & Pages -> Create -> Pages -> Connect to Git.
   - Select your repository.
   - **Build Settings**: Leave everything blank (Build command and Build output directory should be empty if your files are in the root).
3. **Set Environment Variables**:
   - Inside your Cloudflare Pages project, go to **Settings** -> **Variables and Secrets**.
   - Add these three variables so the backend can talk to your server:
     - `PANEL_URL` : (e.g., `http://1.2.3.4:2053`)
     - `PANEL_USERNAME` : (your admin user)
     - `PANEL_PASSWORD` : (your admin pass)
4. **Deploy**: Cloudflare will automatically detect the `functions` folder and use it as your backend!

## 🐳 Coolify / Docker Deployment (Same VPS as 3x-ui)

Run the dashboard on the **same VPS** as your 3x-ui panel using Coolify. The
included `Dockerfile` and `server.js` mirror the Cloudflare Functions exactly,
so behavior is identical — Coolify builds and runs it straight from this repo,
no extra setup files needed.

1. **Coolify → New Resource → Application → Public/Private Repository.**
   - Select this repository and your branch.
   - **Build Pack:** `Dockerfile` (Coolify auto-detects the `Dockerfile` in the repo root).
2. **Environment Variables** (Coolify → your app → Environment Variables):
   - `PANEL_URL` = `http://127.0.0.1:2053` — since the dashboard runs on the same
     VPS, point it at the panel's local address. If both run as Docker containers,
     use the panel's container name instead (e.g. `http://3x-ui:2053`).
   - `PANEL_USERNAME` = your panel admin username.
   - `PANEL_PASSWORD` = your panel admin password (also the dashboard admin token).
   - *(optional)* `PORT` (default `8080`), `METRICS_INTERVAL_MS`, `METRICS_CACHE_TTL`.
3. **Networking:**
   - The container listens on **`8080`** — set this as the exposed/port mapping.
   - Add your **Domain** (e.g. `dashboard.example.com`); Coolify issues a Let's
     Encrypt certificate automatically.
   - If using `PANEL_URL=http://127.0.0.1:2053`, enable **host networking** (or
     map the host) so the container can reach the panel on localhost. Otherwise
     put the panel and dashboard on the same Coolify/Docker network and use the
     container name.
4. **Deploy.** Coolify builds the image and starts it. A built-in `/healthz`
   route is available for Coolify's Health Check setting. Every push to the
   selected branch auto-redeploys.

### If ports 80/443 are already taken (run on a custom port, no proxy)

If your 3x-ui panel (or another app) already owns `80`/`443`, Coolify's built-in
proxy can't route a domain to the dashboard. In that case, skip the proxy and
publish the container on a **direct custom port** instead:

1. **Coolify → your app → Configuration → Network → "Ports Mappings"**
   - Set `8090:8080` (host `8090` → container `8080`). Pick any free, non-common
     host port; confirm it's free first: `sudo ss -tulpn | grep :8090`.
   - Leave the **Domains** field empty (you're not using the proxy).
2. **Open the port in your firewall.** On Oracle Cloud (and most VPS) the port is
   blocked by default at two layers:
   - **Cloud Security List / firewall:** add an Ingress rule allowing TCP `8090`
     from `0.0.0.0/0` (Oracle Cloud → VCN → Security Lists).
   - **Host iptables:** `sudo iptables -I INPUT -p tcp --dport 8090 -j ACCEPT`
     then persist (`sudo netfilter-persistent save`, or use `ufw allow 8090/tcp`).
3. **Redeploy**, then open `http://YOUR_VPS_IP:8090`.

The dashboard's env vars stay the same (`PANEL_URL`, `PANEL_USERNAME`,
`PANEL_PASSWORD`) — only the external port changes.

### Clean HTTPS domain behind your existing nginx (recommended)

If your panel already owns 80/443 but you want a real domain like
`https://dashboard.trackydev.site` (not `IP:port`), reverse-proxy it through the
nginx that's already on the box. A ready-to-use config with SSE support is at
[`deploy/nginx-dashboard.conf`](deploy/nginx-dashboard.conf):

1. **DNS:** `A` record `dashboard.trackydev.site` → your VPS IP.
2. **Publish the container locally** — either:
   - Coolify → app → **Ports Mappings**: `127.0.0.1:8090:8080`, **or**
   - Deploy with the committed [`docker-compose.yml`](docker-compose.yml)
     (Coolify → Build Pack: *Docker Compose*), which already maps
     `127.0.0.1:8090:8080` in code.

   Either way it's bound to localhost, so it stays private and needs **no**
   firewall/Security-List change.
3. **Run the automated setup script** (installs nginx/certbot if needed, writes
   the config, repairs any broken symlink, reloads, and issues the TLS cert):
   ```bash
   sudo bash deploy/setup-dashboard.sh vps.trackydev.site
   # optional: sudo bash deploy/setup-dashboard.sh vps.trackydev.site 127.0.0.1:8090 you@mail.com
   ```
   Not got the repo on the VPS? Paste the same script inline — see the chat/PR,
   or `curl` it from your branch. It's idempotent and safe to re-run.
4. Open `https://vps.trackydev.site`.

   *(Manual equivalent, if you prefer: copy `deploy/nginx-dashboard.conf` to
   `/etc/nginx/sites-available/`, symlink it into `sites-enabled/`, `nginx -t`,
   reload, then `certbot --nginx -d <domain>`.)*

## 📦 Local Installation (Optional)
1. Install dependencies: `npm install`
2. Set env vars: `PANEL_URL`, `PANEL_USERNAME`, `PANEL_PASSWORD` (defaults target `http://127.0.0.1:2053`).
3. Start: `npm start` — serves the dashboard and panel proxy on port `8080` (override with `PORT`).

## 🎨 Features
- **Zero-Latency Monitoring**: Hosted on Cloudflare's Edge.
- **Mobile Optimized**: Home, Nodes, Users, and System tabs.
- **GSAP & Three.js**: High-end animations and 3D backgrounds.
