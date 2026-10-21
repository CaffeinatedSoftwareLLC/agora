import type { FastifyInstance } from 'fastify';

export class ServiceUnavailableError extends Error {
    constructor(cause?: unknown) { super('service_unavailable', { cause }); }
}

/** Dependency failures only: validation, constraints and programming errors keep their usual response. */
export function isServiceUnavailable(error: unknown): boolean {
    if (error instanceof ServiceUnavailableError) return true;
    if (!(error instanceof Error)) return false;
    const code = (error as NodeJS.ErrnoException).code ?? '';
    return code.startsWith('08') || ['57014', '57P01', '57P02', '57P03', '53300',
        'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENETUNREACH', 'EHOSTUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)
        || /^(?:timeout exceeded when trying to connect|Connection terminated(?: unexpectedly| due to connection timeout)?|Connection is closed\.|Command timed out|Query read timeout)$/.test(error.message)
        || error.name === 'MaxRetriesPerRequestError';
}

export function installDependencyErrorHandler(app: FastifyInstance) {
    app.setErrorHandler((error, request, reply) => {
        if (isServiceUnavailable(error)) {
            request.log.warn({ err: error }, 'Request dependency unavailable');
            return reply.code(503).header('Retry-After', '5').send({ error: 'service_unavailable' });
        }
        return reply.send(error);
    });
}
