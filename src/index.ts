import { buildApp } from './app';
import { config } from './config';
import { isInstanceInitialized } from './instance/check-initialized';
import { getSetupToken } from './instance/setup-token';

async function main() {
    const host = process.env.HOST ?? '0.0.0.0';

    const { app, db } = await buildApp({
        logger: true,
        jwtSecret: config.jwtSecret,
        dbUrl: config.dbUrl,
    });

    await app.listen({ port: config.port, host });
    console.log(`Agora listening on ${host}:${config.port}`);

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
