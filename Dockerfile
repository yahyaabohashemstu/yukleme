# =============================================================================
# Yükleme Belgesi — production image for Coolify / Hetzner
#
# Multi-stage build on a glibc (bookworm) Node 20 base. We use a custom
# Dockerfile (NOT Nixpacks) because better-sqlite3 is a native module: it needs
# python3 + make + g++ available at `npm install` time. bookworm-slim (glibc)
# is used instead of alpine (musl) so better-sqlite3's prebuilt binary matches.
# =============================================================================

# ---- build stage -----------------------------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Toolchain for node-gyp / better-sqlite3
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Install production deps with a reproducible lockfile install
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY . .

# ---- runtime stage ---------------------------------------------------------
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Create the mount points for the persistent volumes and own them as the
# non-root `node` user so SQLite can create app.db-wal / app.db-shm and multer
# can write uploads without EACCES.
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app

COPY --chown=node:node --from=build /app /app

USER node
EXPOSE 5000

# Default runtime paths (override via Coolify env if you like). These MUST point
# at the persistent volumes mounted in Coolify, or data is lost on redeploy.
ENV DB_PATH=/app/data/app.db
ENV UPLOADS_DIR=/app/uploads

# Container health: hit the unauthenticated /healthz route. node:20-slim has no
# curl/wget, so use a tiny Node probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||5000)+'/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
