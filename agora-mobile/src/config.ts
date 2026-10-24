declare const __AGORA_RELAY_URL__: string;
declare const __AGORA_APP_VERSION__: string;

/** From app.config.json, fixed at build time (vite `define`). */
export const RELAY_URL: string = __AGORA_RELAY_URL__;
/** From package.json, used if the native App plugin cannot report the version. */
export const APP_VERSION: string = __AGORA_APP_VERSION__;
