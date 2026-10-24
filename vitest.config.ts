import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        testTimeout: 30000,
        hookTimeout: 30000,
        globalSetup: ['test/global-setup.ts'],
        fileParallelism: false,
        // File uploads go to the disk store; keep test blobs out of the repo
        env: { STORAGE_DIR: path.join(os.tmpdir(), 'agora-test-files') },
        // test/sandbox needs Docker + the socket proxy: run with `npm run test:sandbox`.
        // .claude/** holds agent worktrees (copies of this repo's tests).
        // agora-ui, agora-mcp and agora-host have their own vitest configs; e2e/ is Playwright.
        exclude: ['**/node_modules/**', '**/dist/**', 'agora-ui/**', 'agora-mcp/**', 'agora-host/**', 'e2e/**', 'test/sandbox/**', '.claude/**'],
    },
});
