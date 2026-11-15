# App image: Node.js + ffmpeg (with libsrt/libopus) for SRT ingest and decoding.
# Referenced by the Fargate CDK construct in ../infra.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# ffmpeg from Debian includes libsrt and libopus support.
# ca-certificates: @livekit/rtc-node (native Rust) needs the system CA store for wss://.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
# Pronunciation readings (POLLY_READINGS_FILE default: /app/assets/polly-readings.csv).
COPY assets ./assets

# SRT ingest (UDP) and health check (TCP).
EXPOSE 9000/udp
EXPOSE 8080/tcp

CMD ["node", "dist/main.js"]
