import { readFileSync } from 'node:fs';

const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));

/** Build-time constants shared by both vite configs (and vitest). Source: app.config.json. */
export const defines = {
    __AGORA_RELAY_URL__: JSON.stringify(read('./app.config.json').relayUrl),
    __AGORA_APP_VERSION__: JSON.stringify(read('./package.json').version),
};
