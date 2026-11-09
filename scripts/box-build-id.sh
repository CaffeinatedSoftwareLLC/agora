#!/bin/sh
# The box image's build ID (docs/agent-boxes.md, "Versioned"): a hash of what goes into a box
# besides its base image and pinned CLIs, i.e. agora-host and agora-mcp (sources and lockfiles)
# and box/. Compose passes it as the BOX_BUILD build arg (AGORA_BOX_BUILD), the image carries
# it as the label org.agora.box.build, and boxd rebuilds a box whose container has another one.
# Base image or apt layer changes don't change it, so they never rebuild running boxes.
#
#   AGORA_BOX_BUILD=$(sh scripts/box-build-id.sh) docker compose -f docker-compose.prod.yml build
#
# Prints nothing (and boxd then never rebuilds for a newer build) when no hash tool is found.
set -eu
cd "$(dirname "$0")/.."
if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$@"; }
elif command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$@"; }
else exit 0; fi
# Path and content of each file, in a fixed order; CRLF counts as LF (a Windows checkout)
find agora-host/src agora-mcp/src box \
     agora-host/package.json agora-host/package-lock.json agora-mcp/package.json agora-mcp/package-lock.json \
     -type f 2>/dev/null | LC_ALL=C sort | while IFS= read -r f; do
    printf '%s %s\n' "$f" "$(tr -d '\r' < "$f" | sum | cut -c1-64)"
done | sum | cut -c1-32
