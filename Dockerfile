# Lean Coffee — containerized
# Multi-step-friendly layering for quick rebuilds

FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Install curl for healthcheck (tiny)
RUN apk add --no-cache curl

# Install deps with cached layer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy app sources
COPY public ./public
COPY server.js ./server.js

# Ensure non-root user can write to data dir
RUN mkdir -p /app/data && chown -R node:node /app

# Harden: run as non-root
USER node

EXPOSE 3000

# Basic container healthcheck (expects 200 on /)
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/ || exit 1

CMD ["node", "server.js"]
