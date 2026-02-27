import { buildApp } from './app';
import { config } from './config';
import { isInstanceInitialized } from './instance/check-initialized';
import { getSetupToken } from './instance/setup-token';
import { ensureBucket, minioClient, BUCKET_NAME } from './lib/minio';
import { startFileCleanupWorker } from './workers/file-cleanup';

async function main() {
    const host = process.env.HOST ?? '0.0.0.0';

    const { app, db } = await buildApp({
        logger: true,
        jwtSecret: config.jwtSecret,
        dbUrl: config.dbUrl,
    });

    await app.listen({ port: config.port, host });
    console.log(`Agora listening on ${host}:${config.port}`);

    // Ensure MinIO bucket exists for file uploads
    await ensureBucket();

    // Start file cleanup worker (runs hourly, non-blocking)
    startFileCleanupWorker({
        redisUrl: config.redisUrl,
        dbUrl: config.dbUrl,
        minioClient,
        bucketName: BUCKET_NAME,
    }).catch(err => {
        console.error('Failed to start file cleanup worker:', err);
    });

    // Print setup token on startup if instance is not yet initialized
    const initialized = await isInstanceInitialized(db);
    if (!initialized) {
        await getSetupToken();
    }

    const shutdown = async () => {
        console.log('Shutting down...');
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
