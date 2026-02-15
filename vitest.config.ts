import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        globals: true,
        testTimeout: 30000,
        hookTimeout: 30000,
        globalSetup: ['test/global-setup.ts'],
        fileParallelism: false,
    },
});
