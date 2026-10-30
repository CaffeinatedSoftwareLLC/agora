import { defineConfig } from 'vite';
import { defines } from './build-defines';

// The server picker: the app's bundled start page.
export default defineConfig({
    base: './',
    define: defines,
    build: { outDir: 'dist', emptyOutDir: true, target: 'es2020' },
});
