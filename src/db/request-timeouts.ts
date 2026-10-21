import { AsyncLocalStorage } from 'node:async_hooks';
import { Client, type QueryConfig } from 'pg';
import { ServiceUnavailableError } from '../lib/service-unavailable';

export const DB_CONNECT_TIMEOUT_MS = 5000;
export const DB_CONTROL_TIMEOUT_MS = 5000;
export const DB_STATEMENT_TIMEOUT_MS = 15000;
export const DB_QUERY_TIMEOUT_MS = DB_STATEMENT_TIMEOUT_MS + 2000;
export const REDIS_COMMAND_TIMEOUT_MS = 2000;

// The pool is also used by workers. Only HTTP request descendants get query deadlines.
// Deactivation before post-response events prevents background work inheriting a limit.
const requests = new AsyncLocalStorage<{ active: boolean }>();
export function enterRequestDbScope(next: () => void) { requests.run({ active: true }, next); }
export function leaveRequestDbScope() { const scope = requests.getStore(); if (scope) scope.active = false; }

/** pg's query_timeout rejects without closing the socket. Destroy it so rollback cannot queue
 * forever behind the timed-out query, and a still-running writer never returns to the pool. */
export class RequestClient extends Client {
    query: Client['query'] = ((...args: any[]) => {
        if (!requests.getStore()?.active) return (super.query as any)(...args);
        const [text, values] = args;
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
        const cfg = typeof text === 'string' ? { text, values: Array.isArray(values) ? values : undefined } : { ...text };
        const control = /^\s*(?:BEGIN\b|COMMIT\b|ROLLBACK\b|SET\s+LOCAL\b|SELECT\s+set_config\s*\()/i.test(cfg.text ?? '');
        cfg.query_timeout = control ? DB_CONTROL_TIMEOUT_MS : DB_QUERY_TIMEOUT_MS;
        const run = async () => {
            try {
                const result = await super.query(cfg);
                if (/^\s*BEGIN\b/i.test(cfg.text)) {
                    // LOCAL is reset by COMMIT/ROLLBACK, including short host-claim transactions.
                    const setup: QueryConfig & { query_timeout: number } = {
                        text: `SET LOCAL statement_timeout = '${DB_STATEMENT_TIMEOUT_MS}ms'`, query_timeout: DB_CONTROL_TIMEOUT_MS,
                    };
                    await super.query(setup);
                }
                return result;
            } catch (error) {
                if (error instanceof Error && error.message === 'Query read timeout') {
                    void this.end().catch(() => {});
                    throw new ServiceUnavailableError(error);
                }
                throw error;
            }
        };
        const result = run();
        if (callback) { void result.then(value => callback(null, value), error => callback(error)); return; }
        return result;
    }) as Client['query'];
}
