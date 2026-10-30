# syntax=docker/dockerfile:1

# ---------- build ----------
# better-sqlite3 punya prebuild, tapi kalau tidak cocok ia kompilasi dari source,
# jadi toolchain build disiapkan di stage ini (tidak ikut ke image runtime).
FROM node:22-bookworm-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build \
  && npm prune --omit=dev \
  && npm cache clean --force

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=5001
ENV DB_PATH=/data/nexgas.sqlite
WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package*.json ./

# Database SQLite persisten; mount volume ke /data di platform hosting.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
