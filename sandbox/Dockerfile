# Agora sandbox image (sandbox-isolation-spec §5). Distroless: no shell, no package
# manager. Pin the base by digest for production builds (AGORA_SANDBOX_IMAGE=...@sha256:...).
FROM denoland/deno:distroless-2.9.7

COPY --chown=65532:65532 entry.ts std.ts import_map.json /opt/agora-std/

# Pre-compile so runs can use --cached-only with a read-only rootfs
ENV DENO_DIR=/opt/deno-cache
RUN ["deno", "cache", "--import-map=/opt/agora-std/import_map.json", "/opt/agora-std/entry.ts"]

USER 65532:65532
WORKDIR /scratch
