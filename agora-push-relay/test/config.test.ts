import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const APNS = { APNS_KEY_FILE: '/run/secrets/apns.p8', APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'net.plantbeat.agora' };

describe('loadConfig', () => {
    it('applies defaults', () => {
        const c = loadConfig({ RELAY_SECRET_KEY: KEY });
        expect(c).toMatchObject({ host: '0.0.0.0', port: 8080, dbPath: '/data/relay.db', trustProxy: false, registerPerMinute: 10, handleTtlDays: 365, fcm: null, apns: null });
        expect(c.masterKey).toHaveLength(32);
    });

    it.each([
        ['missing', undefined],
        ['short', 'abcd'],
        ['not hex', 'z'.repeat(64)],
        ['a placeholder', '0'.repeat(64)],
    ])('rejects a %s RELAY_SECRET_KEY without echoing it', (_name, value) => {
        expect(() => loadConfig({ RELAY_SECRET_KEY: value })).toThrow(/RELAY_SECRET_KEY/);
        try {
            loadConfig({ RELAY_SECRET_KEY: value });
        } catch (err) {
            if (value && value.length > 4) expect(String(err)).not.toContain(value);
        }
    });

    it('reads FCM and APNs settings', () => {
        const c = loadConfig({ RELAY_SECRET_KEY: KEY, FCM_SERVICE_ACCOUNT_FILE: '/run/secrets/fcm.json', ...APNS, APNS_ENVIRONMENT: 'sandbox' });
        expect(c.fcm).toEqual({ serviceAccountFile: '/run/secrets/fcm.json' });
        expect(c.apns).toEqual({ keyFile: '/run/secrets/apns.p8', keyId: 'ABC123DEFG', teamId: 'TEAM123456', bundleId: 'net.plantbeat.agora', production: false });
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, ...APNS }).apns?.production).toBe(true);
    });

    it('rejects partial or malformed APNs settings', () => {
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, APNS_KEY_FILE: '/x.p8' })).toThrow(/APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID/);
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, ...APNS, APNS_KEY_ID: 'short' })).toThrow(/APNS_KEY_ID/);
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, ...APNS, APNS_ENVIRONMENT: 'dev' })).toThrow(/APNS_ENVIRONMENT/);
    });

    it('parses RELAY_TRUST_PROXY and numeric limits', () => {
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_TRUST_PROXY: 'true' }).trustProxy).toBe(true);
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_TRUST_PROXY: '127.0.0.1, 172.16.0.0/12' }).trustProxy).toEqual(['127.0.0.1', '172.16.0.0/12']);
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_PORT: 'eighty' })).toThrow(/RELAY_PORT/);
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_HANDLE_TTL_DAYS: '0' }).handleTtlDays).toBe(0);
    });
});
