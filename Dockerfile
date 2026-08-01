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

# Container healthcheck. Coolify's rolling update inspects
# .State.Health.Status, so the image MUST define a HEALTHCHECK or the deploy
# fails with `map has no entry for key "Health"`. We use busybox wget (always
# present in node:*-alpine) against the built-in /healthz route — shell form so
# ${PORT} is expanded at runtime.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

CMD ["node", "server.js"]
