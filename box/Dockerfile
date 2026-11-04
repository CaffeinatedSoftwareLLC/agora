# Agora agent box image (docs/agent-boxes.md §6). Build context = the repo root:
#   docker build -f box/Dockerfile --build-arg BOX_VERSION=$(cat box/VERSION) -t agora/box:$(cat box/VERSION) .
#   docker build -f box/Dockerfile --target test --build-arg BOX_VERSION=$(cat box/VERSION) -t agora/box:$(cat box/VERSION)-test .
# Targets: "box" (the default, last stage) has the pinned Claude Code and Codex CLIs; "test"
# has fake CLIs (box/fake) for the isolation and clean-install tests.
# A change to this file, the pinned CLIs or the in-box scripts bumps box/VERSION.
# Runs with a read-only root, tmpfs /tmp and /run/agora, and /home/agent as a volume.

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- agora-host and agora-mcp, built from this checkout
FROM ${NODE_IMAGE} AS build
WORKDIR /build
COPY agora-mcp/package.json agora-mcp/package-lock.json agora-mcp/
RUN cd agora-mcp && npm ci --no-audit --no-fund
COPY agora-host/package.json agora-host/package-lock.json agora-host/
RUN cd agora-host && npm ci --no-audit --no-fund
COPY agora-mcp/tsconfig.json agora-mcp/
COPY agora-mcp/src agora-mcp/src
COPY agora-host/tsconfig.json agora-host/
COPY agora-host/src agora-host/src
RUN cd agora-mcp && npm run build && npm prune --omit=dev --no-audit --no-fund \
 && cd ../agora-host && npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- everything but the CLIs
FROM ${NODE_IMAGE} AS base
ARG BOX_VERSION
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates jq ripgrep python3 python3-venv build-essential tini \
 && rm -rf /var/lib/apt/lists/*
# uid/gid 1000 is the node image's "node" user; the box's user is "agent"
RUN userdel --remove node \
 && groupadd --gid 1000 agent \
 && useradd --uid 1000 --gid 1000 --home-dir /home/agent --create-home --shell /bin/bash agent \
 && mkdir -p /run/agora /opt/agora/bin && chown 1000:1000 /run/agora && chmod 0700 /run/agora
COPY box/VERSION /opt/agora/VERSION
# The build arg must match box/VERSION: the label is what boxd compares
RUN v=$(tr -d '[:space:]' < /opt/agora/VERSION) \
 && if [ "$v" != "$BOX_VERSION" ]; then echo "BOX_VERSION build arg ($BOX_VERSION) must equal box/VERSION ($v)" >&2; exit 1; fi \
 && printf 'agora-box %s\n' "$v" > /etc/agora-box && chmod 0644 /etc/agora-box
COPY --from=build /build/agora-host/package.json /opt/agora/agora-host/package.json
COPY --from=build /build/agora-host/node_modules /opt/agora/agora-host/node_modules
COPY --from=build /build/agora-host/dist /opt/agora/agora-host/dist
COPY --from=build /build/agora-mcp/package.json /opt/agora/agora-mcp/package.json
COPY --from=build /build/agora-mcp/node_modules /opt/agora/agora-mcp/node_modules
COPY --from=build /build/agora-mcp/dist /opt/agora/agora-mcp/dist
COPY box/agora-box-start /opt/agora/agora-box-start
COPY box/agora-pr /usr/local/bin/agora-pr
COPY box/AGENTS.md /opt/agora/AGENTS.md
RUN chmod 0755 /opt/agora/agora-box-start /usr/local/bin/agora-pr && chmod 0644 /opt/agora/AGENTS.md
ENV HOME=/home/agent \
    PATH=/home/agent/.npm-global/bin:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_UPDATE_NOTIFIER=false
LABEL org.agora.box.version=${BOX_VERSION}
WORKDIR /home/agent
ENTRYPOINT ["tini", "--", "/opt/agora/agora-box-start"]

# ---- test: fake CLIs that answer agora-host's headless modes and the login relay
FROM base AS test
COPY box/fake/fake-cli.mjs /opt/agora/fake/claude.mjs
COPY box/fake/fake-cli.mjs /opt/agora/fake/codex.mjs
RUN chmod 0755 /opt/agora/fake/claude.mjs /opt/agora/fake/codex.mjs \
 && ln -s /opt/agora/fake/claude.mjs /opt/agora/bin/claude \
 && ln -s /opt/agora/fake/codex.mjs /opt/agora/bin/codex
USER 1000:1000

# ---- box: the real CLIs, pinned (agora-host verifies Claude 2.1.x and Codex 0.163.x)
FROM base AS box
ARG CLAUDE_CODE_VERSION=2.1.311
ARG CODEX_VERSION=0.163.0
# HOME=/root: nothing the install or the version checks write may land in the agent's home
RUN export HOME=/root \
 && npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && ln -s /usr/local/bin/claude /opt/agora/bin/claude \
 && ln -s /usr/local/bin/codex /opt/agora/bin/codex \
 && /opt/agora/bin/claude --version && /opt/agora/bin/codex --version \
 && rm -rf /root/.npm /root/.claude /root/.claude.json /root/.codex \
 && test -z "$(find /home/agent -mindepth 1 ! -user 1000 -print -quit)"
USER 1000:1000
