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

## 📦 Local Installation (Optional)
1. Install dependencies: `npm install`
2. Start: `npm start` (Runs the Node.js preview version)

## 🎨 Features
- **Zero-Latency Monitoring**: Hosted on Cloudflare's Edge.
- **Mobile Optimized**: Home, Nodes, Users, and System tabs.
- **GSAP & Three.js**: High-end animations and 3D backgrounds.
