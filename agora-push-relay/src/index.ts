import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { deriveKeys } from './crypto.js';
import { HandleStore, type Platform } from './store.js';
import { ApnsSender, loadApnsKey } from './senders/apns.js';
import { FcmSender, loadServiceAccount } from './senders/fcm.js';
import type { Sender } from './senders/types.js';

const DAY = 86_400_000;

async function main() {
    const config = loadConfig();
    const store = new HandleStore(config.dbPath, deriveKeys(config.masterKey));

    const senders: Partial<Record<Platform, Sender>> = {};
    if (config.fcm) senders.android = new FcmSender(loadServiceAccount(config.fcm.serviceAccountFile));
    if (config.apns) {
        const { keyFile, ...rest } = config.apns;
        senders.ios = new ApnsSender({ keyPem: loadApnsKey(keyFile), ...rest });
    }

    const app = buildApp({
        store,
        senders,
        registerPerMinute: config.registerPerMinute,
        trustProxy: config.trustProxy,
        logger: { level: config.logLevel },
    });
    if (!senders.android && !senders.ios) app.log.warn('no provider configured: every register answers 503 platform_unavailable');
    app.log.info({ android: Boolean(senders.android), ios: Boolean(senders.ios), apnsProduction: config.apns?.production ?? null }, 'providers');

    // Hourly: outcome counts since the last line, then reset. Daily: drop handles unused for the TTL.
    const report = setInterval(() => {
        if (Object.keys(app.counters).length === 0) return;
        app.log.info({ counts: { ...app.counters }, handles: store.count() }, 'hourly counts');
        for (const k of Object.keys(app.counters)) delete app.counters[k];
    }, 3_600_000);
    const prune = () => {
        if (config.handleTtlDays === 0) return;
        const removed = store.pruneSeenBefore(Date.now() - config.handleTtlDays * DAY);
        if (removed > 0) app.log.info({ removed }, 'pruned unused handles');
    };
    prune();
    const pruneTimer = setInterval(prune, DAY);

    let closing = false;
    const shutdown = async (signal: string) => {
        if (closing) return;
        closing = true;
        app.log.info({ signal }, 'shutting down');
        clearInterval(report);
        clearInterval(pruneTimer);
        await app.close();
        await Promise.all(Object.values(senders).map((s) => s?.close?.()));
        store.close();
        process.exit(0);
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));

    await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
    // Config errors name the variable; they never contain secret values.
    console.error(`agora-push-relay: ${err instanceof Error ? err.message : 'failed to start'}`);
    process.exit(1);
});
