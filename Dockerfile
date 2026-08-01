# 3x-ui dashboard — Node/Express container for Coolify (or any Docker host).
# Runs the same proxy/API logic as the Cloudflare Functions, serving the
# static dashboard and talking to your local 3x-ui panel via PANEL_URL.

FROM node:18-alpine

WORKDIR /app

# Install production deps first (better layer caching)
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# Copy the rest of the app
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# NOTE: no Docker HEALTHCHECK here on purpose. A failing container healthcheck
# makes Coolify mark the app "unhealthy" and its proxy (Traefik) then refuses to
# route the domain to it. Let Coolify manage health via its own UI setting
# (Health Check path = /healthz) instead of baking a brittle one into the image.

CMD ["node", "server.js"]
