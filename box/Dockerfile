# Agora agent box image (docs/agent-boxes.md §6). Build context = the repo root:
#   docker build -f box/Dockerfile --build-arg BOX_VERSION=$(cat box/VERSION) -t agora/box:$(cat box/VERSION) .
#   docker build -f box/Dockerfile --target test --build-arg BOX_VERSION=$(cat box/VERSION) -t agora/box:$(cat box/VERSION)-test .
# Targets: "box" (the default, last stage) has the pinned CLIs of every box adapter (Claude
# Code, Codex, opencode, oh-my-pi, Devin); "test" has fake CLIs (box/fake) for the isolation and clean-install
# tests. The pins are also in the box adapter registry (src/lib/boxes/adapters.ts,
# agora-host/src/box-adapters.ts); test/unit/box-adapters.unit.test.ts checks they agree.
# A change to this file, the pinned CLIs or the in-box scripts bumps box/VERSION.
# Runs with a read-only root, tmpfs /tmp, /run/agora, /run/as-agent and /home/operator, and /home/agent
# as a volume. PID 1 is box/agora-box-init, started as root with only the capabilities it needs to
# start the agent's processes (uid 1000) and the owner's terminal relay (uid 1001) apart.

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
 && apt-get install -y --no-install-recommends git curl ca-certificates jq ripgrep python3 python3-venv build-essential util-linux \
 && rm -rf /var/lib/apt/lists/*
# uid/gid 1000 is the node image's "node" user; the agent's user is "agent". The owner's own account
# is "operator" (1001): its home is a tmpfs boxd mounts, and neither user is in the other's group.
# The agent's home is closed to everyone else (mode 0700; agora-box-start also sets it on a kept volume).
RUN userdel --remove node \
 && groupadd --gid 1000 agent \
 && useradd --uid 1000 --gid 1000 --home-dir /home/agent --create-home --shell /bin/bash agent \
 && chmod 0700 /home/agent \
 && (getent group operator >/dev/null && groupdel operator || true) \
 && groupadd --gid 1001 operator \
 && useradd --uid 1001 --gid 1001 --home-dir /home/operator --no-create-home --shell /bin/bash operator \
 && install -d -m 0755 -o root -g root /home/operator /run/as-agent \
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
COPY box/agora-box-init /opt/agora/agora-box-init
COPY box/agora-box-start /opt/agora/agora-box-start
COPY box/agora-pr /usr/local/bin/agora-pr
# The pseudo-terminal behind the owner's terminal in Agora (docs/box-terminal.md): Python's own pty
# module, so nothing native to build for amd64 or arm64. Root-owned and read-only like the rest of /opt/agora.
COPY box/agora-pty /opt/agora/agora-pty
# The owner's side: as-agent (run a command with the agent's rights) and the shell's fixed startup
# and git files; the agent's side of as-agent. All root-owned; no file of any home is ever sourced.
COPY box/as-agent /usr/local/bin/as-agent
COPY box/as-agent-server /opt/agora/as-agent-server
COPY box/operator.bashrc /opt/agora/operator.bashrc
COPY box/operator.gitconfig /opt/agora/operator.gitconfig
COPY box/AGENTS.md /opt/agora/AGENTS.md
RUN chmod 0755 /opt/agora/agora-box-init /opt/agora/agora-box-start /usr/local/bin/agora-pr /opt/agora/agora-pty /usr/local/bin/as-agent /opt/agora/as-agent-server \
 && chmod 0644 /opt/agora/AGENTS.md /opt/agora/operator.bashrc /opt/agora/operator.gitconfig
ENV HOME=/home/agent \
    PATH=/home/agent/.npm-global/bin:/home/agent/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    NPM_CONFIG_UPDATE_NOTIFIER=false
LABEL org.agora.box.version=${BOX_VERSION}
WORKDIR /home/agent
# PID 1: starts as root (boxd sets the user), then runs the agent and the owner's relay as their own users
ENTRYPOINT ["/opt/agora/agora-box-init"]

# ---- test: fake CLIs that answer agora-host's headless modes, ACP and the login relay
FROM base AS test
COPY box/fake/fake-cli.mjs /opt/agora/fake/claude.mjs
COPY box/fake/fake-cli.mjs /opt/agora/fake/codex.mjs
COPY box/fake/fake-acp.mjs /opt/agora/fake/opencode.mjs
COPY box/fake/fake-acp.mjs /opt/agora/fake/devin.mjs
RUN chmod 0755 /opt/agora/fake/claude.mjs /opt/agora/fake/codex.mjs /opt/agora/fake/opencode.mjs /opt/agora/fake/devin.mjs \
 && ln -s /opt/agora/fake/claude.mjs /opt/agora/bin/claude \
 && ln -s /opt/agora/fake/codex.mjs /opt/agora/bin/codex \
 && ln -s /opt/agora/fake/opencode.mjs /opt/agora/bin/opencode \
 && ln -s /opt/agora/fake/devin.mjs /opt/agora/bin/devin
COPY box/fake/fake-omp.mjs /opt/agora/fake/omp.mjs
RUN chmod 0755 /opt/agora/fake/omp.mjs && ln -s /opt/agora/fake/omp.mjs /opt/agora/bin/omp
# What agora-host, agora-mcp and box/ were built from (scripts/box-build-id.sh): boxd rebuilds a
# box whose container has another build than the current image. Last, so it busts no cache.
ARG BOX_BUILD=
LABEL org.agora.box.build=${BOX_BUILD}

# ---- box: the real CLIs, pinned (agora-host verifies Claude 2.1.x, Codex 0.163.x, omp
# 18.17.x and Devin 3000.11.x; opencode is checked by its ACP protocol version). One ARG and one install block per
# box adapter.
FROM base AS box
ARG CLAUDE_CODE_VERSION=2.1.311
ARG CODEX_VERSION=0.163.0
ARG OPENCODE_VERSION=1.18.34
ARG OMP_VERSION=18.17.0
ARG DEVIN_VERSION=3000.11.234
# HOME=/root: nothing the install or the version checks write may land in the agent's home
RUN export HOME=/root \
 && npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && npm cache clean --force \
 && ln -s /usr/local/bin/claude /opt/agora/bin/claude \
 && ln -s /usr/local/bin/codex /opt/agora/bin/codex \
 && /opt/agora/bin/claude --version && /opt/agora/bin/codex --version \
 && rm -rf /root/.npm /root/.claude /root/.claude.json /root/.codex
# opencode (MIT): its postinstall links the native binary for this machine's CPU (glibc, AVX2 or
# baseline) into opencode-ai/bin; the other platform packages are then dropped (about 550 MB)
RUN export HOME=/root \
 && npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/opencode-ai/node_modules \
 && ln -s /usr/local/bin/opencode /opt/agora/bin/opencode \
 && /opt/agora/bin/opencode --version \
 && rm -rf /root/.npm /root/.config/opencode /root/.local/share/opencode /root/.local/state/opencode /root/.cache/opencode
# oh-my-pi (MIT): the standalone binary from the GitHub release, checked against the release's
# SHA256SUMS.txt (it releases every few days, so the version and both sums move together, as in
# the box adapter registry). --version writes ~/.omp, which goes with the rest of /root.
RUN export HOME=/root \
 && case "$(dpkg --print-architecture)" in \
      amd64) arch=x64; sum=a4ce6001ab1012ca835f4184d675437531bd1ac477a7ba8424ed0b5476e9e4cb ;; \
      arm64) arch=arm64; sum=a9423fd7a69d869bf514931226b21d4ff55474225f574e2911fec457fc470e68 ;; \
      *) echo "oh-my-pi has no Linux build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 3 -o /usr/local/bin/omp "https://github.com/can1357/oh-my-pi/releases/download/v${OMP_VERSION}/omp-linux-${arch}" \
 && echo "${sum}  /usr/local/bin/omp" | sha256sum -c - \
 && chmod 0755 /usr/local/bin/omp \
 && ln -s /usr/local/bin/omp /opt/agora/bin/omp \
 && /opt/agora/bin/omp --version \
 && rm -rf /root/.omp
# Devin CLI (Cognition; not on npm): the release tarball for this machine's CPU, checked against
# its pinned sha256 (static.devin.ai/cli/<version>/manifest.json; the version and both sums move
# together, as in the box adapter registry). A static binary (about 210 MB); only bin/devin is
# kept, not its bundled docs. `devin setup` (the installer's interactive wizard) is never run, and
# the CLI never updates itself in a box: auto_update is off in its config and static.devin.ai is
# refused at the edge.
RUN export HOME=/root \
 && case "$(dpkg --print-architecture)" in \
      amd64) arch=x86_64; sum=201370cddd2924294e3ca6b46fd8ece49b5763953b644a1dd823fce5490cb41a ;; \
      arm64) arch=aarch64; sum=438ca7f8280b3ef0747afc406e827d9e182156000277a1660358ac4fbd04156e ;; \
      *) echo "Devin has no Linux build for $(dpkg --print-architecture)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL --retry 3 --proto '=https' -o /tmp/devin.tar.gz "https://static.devin.ai/cli/${DEVIN_VERSION}/devin-${DEVIN_VERSION}-${arch}-unknown-linux.tar.gz" \
 && echo "${sum}  /tmp/devin.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/devin \
 && tar -xzf /tmp/devin.tar.gz -C /opt/devin bin/devin \
 && rm /tmp/devin.tar.gz \
 && chown -R root:root /opt/devin && chmod 0755 /opt/devin/bin/devin \
 && ln -s /opt/devin/bin/devin /opt/agora/bin/devin \
 && /opt/agora/bin/devin --version \
 && rm -rf /root/.config/devin /root/.local/share/devin /root/.cache/devin
RUN test -z "$(find /home/agent -mindepth 1 ! -user 1000 -print -quit)"
# What agora-host, agora-mcp and box/ were built from (scripts/box-build-id.sh): boxd rebuilds a
# box whose container has another build than the current image. Last, so it busts no cache.
ARG BOX_BUILD=
LABEL org.agora.box.build=${BOX_BUILD}
