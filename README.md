# 3x-ui Premium Dashboard

A modern, animated, and mobile-responsive dashboard for managing your 3x-ui panel. Built with GSAP, Three.js, and Chart.js.

![Dashboard Preview](https://raw.githubusercontent.com/iamhelitha/3xui-api-client/main/preview.png) *(Placeholder for your preview)*

## Features
- **Modern UI**: Glassmorphism aesthetic with dark mode.
- **Mobile First**: Bottom navigation and optimized cards for phones.
- **Real-time Metrics**: Dynamic charts for CPU, RAM, and Traffic.
- **Proxy Server**: Secure Node.js backend to communicate with your panel.

## Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/3x-ui-dashboard.git
   cd 3x-ui-dashboard
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open your browser at `http://localhost:8000`.

## Configuration
Go to the **System** tab in the dashboard UI to enter your panel URL, username, and password. This will create a `server-config.json` file locally.

## Deployment
For hosting, you can use:
- **VPS**: Run it with `pm2`.
- **Render / Railway**: These platforms support Node.js backends and are easier to set up than Cloudflare for this specific project.

### Cloudflare Note
Note that Cloudflare Pages is for **static** sites. Since this dashboard uses a Node.js backend to bypass CORS and proxy API requests, it cannot be hosted directly on Cloudflare Pages without significant modification. We recommend using a Node.js-friendly host like **Render.com**.
