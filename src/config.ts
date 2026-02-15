export const config = {
    dbUrl: process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
    testDbUrl: process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://accord:accord@localhost:5432/accord_test',
    redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
    jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-do-not-use-in-prod',
    port: parseInt(process.env.PORT ?? '3000', 10),
};
