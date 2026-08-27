FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Non-root user; session files land under /home/worker/.claude/projects/-work/
# (canonical cwd /work fleet-wide — makes cross-container resume a file copy).
RUN useradd -m worker && mkdir -p /work && chown -R worker:worker /work /app
USER worker
ENV HOME=/home/worker
WORKDIR /work

ENTRYPOINT ["node", "/app/dist/main.js"]
