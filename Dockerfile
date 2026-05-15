# syntax=docker/dockerfile:1.7

ARG NODE_VERSION=22-bookworm-slim

FROM node:${NODE_VERSION} AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    g++ \
    make \
    pkg-config \
    python3 \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:${NODE_VERSION} AS runtime

ARG CODEX_CLI_VERSION=latest

LABEL org.opencontainers.image.title="CodexDeck"
LABEL org.opencontainers.image.description="Browser-first control deck for local Codex CLI sessions."
LABEL org.opencontainers.image.url="https://github.com/buaabarty/CodexDeck"
LABEL org.opencontainers.image.source="https://github.com/buaabarty/CodexDeck"
LABEL org.opencontainers.image.licenses="MIT"

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    openssh-client \
    ripgrep \
    sqlite3 \
    tini \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
  && npm cache clean --force

WORKDIR /app

ENV NODE_ENV=production
ENV CODEX_CONTROL_HOST=0.0.0.0
ENV CODEX_CONTROL_PORT=5900
ENV CODEX_DEFAULT_CWD=/workspace

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY public ./public
COPY server ./server
COPY scripts ./scripts

RUN mkdir -p /workspace /app/.runtime \
  && chown -R node:node /app /workspace

USER node

EXPOSE 5900

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const port=process.env.CODEX_CONTROL_PORT||5900; fetch(`http://127.0.0.1:${port}/health`).then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--"]
CMD ["node", "server/index.js"]
