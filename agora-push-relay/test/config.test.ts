import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0';
const APNS = { APNS_KEY_FILE: '/run/secrets/apns.p8', APNS_KEY_ID: 'ABC123DEFG', APNS_TEAM_ID: 'TEAM123456', APNS_BUNDLE_ID: 'com.caffeinatedsoftware.agora' };

describe('loadConfig', () => {
    it('applies defaults', () => {
        const c = loadConfig({ RELAY_SECRET_KEY: KEY });
        expect(c).toMatchObject({ host: '0.0.0.0', port: 8080, store: { kind: 'sqlite', path: '/data/relay.db' }, trustProxy: false, registerPerMinute: 10, handleTtlDays: 365, fcm: null, apns: null });
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
        expect(c.apns).toEqual({ key: { file: '/run/secrets/apns.p8' }, keyId: 'ABC123DEFG', teamId: 'TEAM123456', bundleId: 'com.caffeinatedsoftware.agora', production: false });
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

    it('takes a RELAY_TRUST_PROXY hop count', () => {
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_TRUST_PROXY: '1' }).trustProxy).toBe(1);
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_TRUST_PROXY: '2' }).trustProxy).toBe(2);
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_TRUST_PROXY: '0' })).toThrow(/RELAY_TRUST_PROXY/);
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_TRUST_PROXY: '11' })).toThrow(/RELAY_TRUST_PROXY/);
    });

    it('listens on PORT when set (Heroku), else RELAY_PORT, else 8080', () => {
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, PORT: '41234', RELAY_PORT: '9000' }).port).toBe(41234);
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, PORT: '', RELAY_PORT: '9000' }).port).toBe(9000);
        expect(loadConfig({ RELAY_SECRET_KEY: KEY }).port).toBe(8080);
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, PORT: 'web' })).toThrow(/^PORT must/);
    });
});

describe('loadConfig: secrets as content', () => {
    const SA_JSON = '{"type":"service_account","project_id":"p","client_email":"e@p.iam.gserviceaccount.com","private_key":"SECRET-PEM"}';
    const PEM = '-----BEGIN PRIVATE KEY-----\nMIGTAgEA\n-----END PRIVATE KEY-----';

    it('reads FCM_SERVICE_ACCOUNT_JSON as an alternative to the file', () => {
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, FCM_SERVICE_ACCOUNT_JSON: SA_JSON }).fcm).toEqual({ serviceAccountJson: SA_JSON });
    });

    it('reads APNS_KEY as an alternative to APNS_KEY_FILE, with literal \\n as line breaks', () => {
        const { APNS_KEY_FILE: _f, ...ids } = APNS;
        const oneLine = PEM.replace(/\n/g, '\\n');
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, ...ids, APNS_KEY: oneLine }).apns?.key).toEqual({ pem: PEM });
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, ...ids, APNS_KEY: PEM }).apns?.key).toEqual({ pem: PEM });
        // APNS_KEY counts as the key for the all-or-nothing check.
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, APNS_KEY: PEM })).toThrow(/APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID/);
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, ...ids })).toThrow(/APNS_KEY_FILE or APNS_KEY/);
    });

    it('refuses both forms of one secret, without echoing either', () => {
        const both = [
            { FCM_SERVICE_ACCOUNT_FILE: '/run/secrets/fcm.json', FCM_SERVICE_ACCOUNT_JSON: SA_JSON },
            { ...APNS, APNS_KEY: PEM },
        ];
        for (const env of both) {
            let message = '';
            try {
                loadConfig({ RELAY_SECRET_KEY: KEY, ...env });
            } catch (err) {
                message = String(err);
            }
            expect(message).toMatch(/not both/);
            for (const secret of ['SECRET-PEM', 'MIGTAgEA']) expect(message).not.toContain(secret);
        }
    });
});

describe('loadConfig: database', () => {
    it('uses SQLite unless DATABASE_URL is set', () => {
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_DB_PATH: './relay.db' }).store).toEqual({ kind: 'sqlite', path: './relay.db' });
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, DATABASE_URL: ' ' }).store.kind).toBe('sqlite');
    });

    it('uses Postgres with TLS for a remote host and without it for this host', () => {
        const remote = 'postgres://u:pw@ec2-1-2-3-4.compute-1.amazonaws.com:5432/d1';
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, DATABASE_URL: remote }).store).toEqual({ kind: 'postgres', url: remote, ssl: true });
        for (const host of ['localhost', '127.0.0.1', '[::1]']) {
            expect(loadConfig({ RELAY_SECRET_KEY: KEY, DATABASE_URL: `postgresql://u:pw@${host}:5432/d` }).store).toMatchObject({ kind: 'postgres', ssl: false });
        }
    });

    it('RELAY_DB_SSL overrides the guess', () => {
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, DATABASE_URL: 'postgres://u:pw@db:5432/d', RELAY_DB_SSL: 'disable' }).store).toMatchObject({ ssl: false });
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, DATABASE_URL: 'postgres://u:pw@localhost/d', RELAY_DB_SSL: 'require' }).store).toMatchObject({ ssl: true });
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, DATABASE_URL: 'postgres://u:pw@db/d', RELAY_DB_SSL: 'verify-full' })).toThrow(/RELAY_DB_SSL/);
    });

    it('refuses TLS settings in the URL and bad URLs, without echoing the password', () => {
        for (const url of ['postgres://u:PASSWORD-CANARY@db/d?sslmode=require', 'mysql://u:PASSWORD-CANARY@db/d', 'not a url PASSWORD-CANARY']) {
            let message = '';
            try {
                loadConfig({ RELAY_SECRET_KEY: KEY, DATABASE_URL: url });
            } catch (err) {
                message = String(err);
            }
            expect(message).toMatch(/DATABASE_URL/);
            expect(message).not.toContain('PASSWORD-CANARY');
        }
    });

    it('reads the telemetry admin token and problem retention', () => {
        expect(loadConfig({ RELAY_SECRET_KEY: KEY })).toMatchObject({ adminToken: undefined, problemDays: 90 });
        const token = 'c'.repeat(64);
        expect(loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_ADMIN_TOKEN: token, RELAY_PROBLEM_DAYS: '30' })).toMatchObject({ adminToken: token, problemDays: 30 });
        expect(() => loadConfig({ RELAY_SECRET_KEY: KEY, RELAY_ADMIN_TOKEN: 'short' })).toThrow(/RELAY_ADMIN_TOKEN/);
    });
});
