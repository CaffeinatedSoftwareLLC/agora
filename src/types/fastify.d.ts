import type { PoolClient } from 'pg';

declare module 'fastify' {
    interface FastifyRequest {
        /** Per-request database client with active transaction. Set in onRequest hook. */
        dbClient: PoolClient | null;
        /** Authenticated user ID (human or bot). Set by requireAuth middleware. */
        userId: string;
        /** True when the request was authenticated with a Bot token. */
        isBot: boolean;
        /** True when the user has instance admin privileges. Set by requireInstanceAdmin. */
        isInstanceAdmin: boolean;
        /** Socket.IO events queued during the request, flushed after COMMIT. */
        pendingEvents: Array<{ event: string; room: string; data: any }>;
        /** User IDs to force-disconnect after COMMIT (e.g. suspended users). */
        pendingDisconnects: string[];
        /** Redis cache key for bot idempotency. Set when Idempotency-Key header is present. */
        idempotencyKey: string | undefined;
        /** Response body cached for idempotency replay. */
        idempotencyResponseBody: unknown;
    }

    interface FastifyInstance {
        db: import('pg').Pool;
        jwtSecret: string;
        ipEncryptionKey: Buffer;
        io: import('socket.io').Server;
    }
}
