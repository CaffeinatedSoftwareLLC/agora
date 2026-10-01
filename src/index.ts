import { buildApp } from './app';
import { config, assertProductionJwtSecret } from './config';
import { isInstanceInitialized } from './instance/check-initialized';
import { getSetupToken } from './instance/setup-token';
import { verifyEncryptionKeyAtStartup } from './lib/key-fingerprint';
import { storage } from './lib/storage';
import { startFileCleanupWorker } from './workers/file-cleanup';
import { startFileTaggingWorker } from './workers/file-tagging';

async function main() {
    const host = process.env.HOST ?? '0.0.0.0';
    assertProductionJwtSecret();

    const { app, db } = await buildApp({
        logger: true,
        jwtSecret: config.jwtSecret,
        dbUrl: config.dbUrl,
    });

    // Refuse to serve with a different encryption key than the one the data was written with
    await verifyEncryptionKeyAtStartup(db, config.encryptionKey);

    await app.listen({ port: config.port, host });
    console.log(`Agora listening on ${host}:${config.port}`);

    // Create the file store's directory or bucket
    await storage.init();

    // Start file cleanup worker (runs hourly, non-blocking)
    startFileCleanupWorker({
        redisUrl: config.redisUrl,
        dbUrl: config.dbUrl,
        store: storage,
    }).catch(err => {
        console.error('Failed to start file cleanup worker:', err);
    });

    // File tagging worker: idle unless a server has switched file tagging on
    // (stopped in shutdown below: hooks cannot be added once the server is listening)
    const stopTagging = startFileTaggingWorker({ db, store: storage, encryptionKey: config.encryptionKey, log: app.log });

    // Print setup token on startup if instance is not yet initialized
    const initialized = await isInstanceInitialized(db);
    if (!initialized) {
        await getSetupToken();
    }

    const shutdown = async () => {
        console.log('Shutting down...');
        // Let a tagging job in flight finish its write before the pool goes away
        await stopTagging().catch(() => {});
        await app.close();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

main().catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
});
