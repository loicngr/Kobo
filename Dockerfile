# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app

# node-pty ships no prebuilt binary for this platform and compiles from
# source via node-gyp during `npm ci`, which needs Python + a toolchain.
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 \
      build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install root deps (mirrors `make install`).
COPY package.json package-lock.json ./
RUN npm ci

# Client's postinstall (`quasar prepare`) needs the full project present
# (quasar.config.js etc.), not just package.json, so copy sources first.
COPY . .
RUN cd src/client && npm ci

# Build (mirrors `npm run build`: build:client → quasar build,
# build:server → tsc).
RUN npm run build

# ── Runtime stage ────────────────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app

# OS-level tools the agents and forge CLIs need, plus a Docker CLI (talks to
# the HOST's daemon via a mounted socket — see docker-compose.example.yml;
# accepted knowingly, this grants root-equivalent host access, see
# CONFIGURATION.md), an SSH server for interactive shell access, and a fuller
# toolset for working inside the container by hand. No whisper.cpp build step
# — voice transcription is excluded from this image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git \
      openssh-client \
      openssh-server \
      ripgrep \
      fd-find \
      jq \
      curl \
      python3 \
      python3-pip \
      build-essential \
      ca-certificates \
      gnupg \
      tmux \
      sudo \
      procps \
      vim \
      nano \
      less \
      make \
      wget \
      unzip \
      htop \
      bash-completion \
    && mkdir -p /run/sshd \
    && sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config \
    && sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config \
    && curl -fsSL https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && GLAB_VERSION="$(curl -fsSL -o /dev/null -w '%{url_effective}' \
         https://gitlab.com/gitlab-org/cli/-/releases/permalink/latest | sed 's#.*/v##')" \
    && curl -fsSL \
      "https://gitlab.com/gitlab-org/cli/-/releases/v${GLAB_VERSION}/downloads/glab_${GLAB_VERSION}_linux_amd64.deb" \
      -o /tmp/glab.deb \
    && apt-get install -y --no-install-recommends /tmp/glab.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/glab.deb

# Production dependencies only (root tree — the client's own node_modules
# aren't needed at runtime, its build output is static files).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Global CLIs for interactive use inside the container (`claude /login`,
# `codex login`) — separate from Kōbō's own bundled @openai/codex dependency,
# which it spawns internally without needing this global install.
RUN npm install -g @anthropic-ai/claude-code @openai/codex

# Built output, preserving the same relative layout the server expects at
# runtime (src/server/utils/paths.ts's getClientSpaPath() looks for
# src/client/dist/spa relative to the package root).
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/client/dist ./src/client/dist
# In-app "What's new" dialog reads this at runtime — without it the route
# degrades to an empty version list instead of crashing, but silently.
COPY --from=build /app/CHANGELOG.md ./CHANGELOG.md

ENV NODE_ENV=production
ENV SERVER_PORT=3000
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f "http://localhost:${SERVER_PORT}/api/health" || exit 1

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["npm", "start"]
