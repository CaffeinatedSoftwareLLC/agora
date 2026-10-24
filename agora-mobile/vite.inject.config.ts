import { defineConfig } from 'vite';
import { defines } from './build-defines';

// agora-native.js: injected by the native code into saved instance pages only.
// One self-contained classic script (IIFE), so it runs at document start.
export default defineConfig({
    define: defines,
    build: {
        outDir: 'dist',
        emptyOutDir: false,
        target: 'es2020',
        lib: {
            entry: 'src/inject/agora-native.ts',
            formats: ['iife'],
            name: 'AgoraNativeInject',
            fileName: () => 'agora-native.js',
        },
    },
});
