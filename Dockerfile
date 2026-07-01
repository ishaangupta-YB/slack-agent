FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY skills ./skills
COPY manifest.json ./

RUN npm run build

FROM node:22-alpine

WORKDIR /app

RUN apk add --no-cache git wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/manifest.json ./

ENV NODE_ENV=production
ENV SESSIONS_DIR=/app/data/sessions
ENV MEMORY_FILE=/app/data/sessions/memory.json
ENV THREAD_MAP_FILE=/app/data/sessions/thread-map.json
ENV BUCKET_DIR=/app/data/bucket
ENV BUCKET_HTTP_PORT=3001
ENV PORT=3001

VOLUME ["/app/data"]

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3001/health || exit 1

CMD ["node", "dist/app.js"]
