import { buildApp } from './app';
import { config } from './config';

async function main() {
    const host = process.env.HOST ?? '0.0.0.0';

    const { app } = await buildApp({
        logger: true,
        jwtSecret: config.jwtSecret,
        dbUrl: config.dbUrl,
    });

    await app.listen({ port: config.port, host });
    console.log(`Agora listening on ${host}:${config.port}`);

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
