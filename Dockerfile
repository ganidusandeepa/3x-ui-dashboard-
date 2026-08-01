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

# Simple container healthcheck against the built-in /healthz route
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+ (process.env.PORT||8080) +'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
