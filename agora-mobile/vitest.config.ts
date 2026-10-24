import { defineConfig } from 'vitest/config';
import { defines } from './build-defines';

export default defineConfig({
    define: defines,
    test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
