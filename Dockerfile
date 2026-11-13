# Multi-stage production build for NEX-GAS Backend
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install build dependencies for native modules (better-sqlite3)
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# Copy dependency manifests
COPY package*.json tsconfig.json ./

# Install all dependencies (including devDependencies for TypeScript compilation)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# Production runtime stage
FROM node:22-bookworm-slim AS runner

WORKDIR /app

# Install build tools for native dependencies in production
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=5001
ENV DATABASE_DRIVER=turso
ENV TURSO_DATABASE_URL=libsql://nexgas-db-0xbonson.aws-ap-southeast-1.turso.io
ENV TURSO_AUTH_TOKEN=eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJhIjoicnciLCJpYXQiOjE3OTM0NTIzNDAsImlkIjoiMDFhMTkxZmItMmEwMS03ZTcyLWEzNGMtNWQ0YWNlNWY0NmFjIiwia2lkIjoiR3ZsLV8xRFRhcVU3OW9FV2NBN0ltakFzaWRjX1I3MXFWd05oa0FpYVZCWSIsInJpZCI6IjM2NGIzMGQzLWE2NGYtNDUxNi04NGFmLWU5OTEwNzJjMjE1MCJ9.25XX4-mbrdO4iUo17DDzatbCFnjTUfGDNsw8Cv2meGWJnWF1CfYfoi0AMUFpH8uih4cKdPikNZv_IdRTYQEaCg
ENV MQTT_HOST=broker.hivemq.com
ENV MQTT_PORT=1883
ENV MQTT_PROTOCOL=mqtt
ENV MQTT_USERNAME=""
ENV MQTT_PASSWORD=""
ENV MQTT_CONNECT_ON_STARTUP=true
ENV PUBLIC_MQTT_TEST_MODE=true
ENV DEFAULT_DEVICE_ID=nexgas-001
ENV CORS_ALLOWED_ORIGINS=*

# Copy dependency manifests and install production-only dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled JavaScript output
COPY --from=builder /app/dist ./dist

# Create and switch to non-root user
USER node

EXPOSE 5001

# Health check via /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 5001) + '/health', (r) => { if (r.statusCode !== 200) process.exit(1); });"

CMD ["node", "dist/index.js"]
