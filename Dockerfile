# Harbor API — Fastify + better-sqlite3, run via tsx (no compile step)
FROM node:20-bookworm-slim

# better-sqlite3 builds a native addon at install time
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
RUN npm ci

COPY apps/api apps/api
COPY scripts scripts

ENV NODE_ENV=production
EXPOSE 8788

ENTRYPOINT ["sh", "-c", "npm run seed && npm run start --workspace apps/api"]
