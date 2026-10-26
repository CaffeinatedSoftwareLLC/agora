import { describe, expect, it } from 'vitest';
import { nativeBridgeMissing } from '../src/lib/webview';

describe('nativeBridgeMissing', () => {
    it('is true inside the app when the shell withheld the bridge (old Android WebView)', () => {
        expect(nativeBridgeMissing({ WEBVIEW_SERVER_URL: 'https://localhost' }, false)).toBe(true);
    });

    it('is false with the bridge, and in a desktop browser (no Capacitor globals)', () => {
        expect(nativeBridgeMissing({ WEBVIEW_SERVER_URL: 'https://localhost' }, true)).toBe(false);
        expect(nativeBridgeMissing({ WEBVIEW_SERVER_URL: 'capacitor://localhost' }, true)).toBe(false);
        expect(nativeBridgeMissing({}, false)).toBe(false);
        expect(nativeBridgeMissing({ WEBVIEW_SERVER_URL: '' }, false)).toBe(false);
    });
});
