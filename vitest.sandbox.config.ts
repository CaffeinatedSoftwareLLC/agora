import { defineConfig } from 'vitest/config';

// Sandbox runner tests: real containers through the socket proxy.
// Requires: `docker compose --profile sandbox up -d socket-proxy`, the sandbox image
// (`docker build -t agora/sandbox-deno:dev sandbox`), and the internal network
// (`docker network create --internal agora_sandbox`). See docs/getting-started.md.
export default defineConfig({
    test: {
        globals: true,
        testTimeout: 120000,
        hookTimeout: 60000,
        globalSetup: ['test/global-setup.ts'],
        fileParallelism: false,
        include: ['test/sandbox/**/*.test.ts'],
    },
});
