# Agora sandbox image (sandbox-isolation-spec §5). Distroless: no shell, no package
# manager. Pin the base by digest for production builds (AGORA_SANDBOX_IMAGE=...@sha256:...).
FROM denoland/deno:distroless-2.9.7

COPY --chown=65532:65532 entry.ts /opt/agora-std/entry.ts

# Pre-compile the entrypoint so runs can use --cached-only with a read-only rootfs
ENV DENO_DIR=/opt/deno-cache
RUN ["deno", "cache", "/opt/agora-std/entry.ts"]

USER 65532:65532
WORKDIR /scratch
