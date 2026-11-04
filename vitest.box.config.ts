import { defineConfig } from 'vitest/config';

// Box suites (test/boxes, docs/agent-boxes.md §14): a real stack with boxd, the edge and boxes.
// Run them with scripts/test-boxes.sh, which starts that stack and passes BOXTEST_* to the tests.
export default defineConfig({
    test: {
        globals: true,
        testTimeout: 300000,
        hookTimeout: 900000,
        fileParallelism: false,
        include: ['test/boxes/**/*.box.test.ts'],
    },
});
