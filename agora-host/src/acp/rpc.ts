import type { Readable, Writable } from 'node:stream';

/**
 * Newline-delimited JSON-RPC 2.0 over an ACP agent's stdio (agentclientprotocol.com,
 * "Transports"). Both sides send requests: the host calls `initialize`, `session/prompt`
 * and so on; the agent calls back with `session/request_permission`. Raw traffic is never
 * logged: it carries prompts, file contents and the bot token for the MCP server.
 */

/** A JSON-RPC error from the agent, or one the host sends back. */
export class RpcError extends Error {
    constructor(public readonly code: number, message: string, public readonly data?: unknown) { super(message); }
}
export const METHOD_NOT_FOUND = -32601;
export const AUTH_REQUIRED = -32000;

export interface Handlers {
    request(method: string, params: unknown): Promise<unknown>;
    notification(method: string, params: unknown): void;
}

type Id = number | string | null;
const isId = (v: unknown): v is Id => v === null || typeof v === 'string' || (typeof v === 'number' && Number.isSafeInteger(v));

export class Connection {
    private nextId = 1;
    private pending = new Map<number, { resolve(v: unknown): void; reject(e: unknown): void; timer?: ReturnType<typeof setTimeout> }>();
    private buffer = '';
    private closedWith: Error | null = null;

    constructor(input: Readable, private output: Writable, private handlers: Handlers, private maxLine = 8 * 1024 * 1024) {
        input.setEncoding('utf8');
        input.on('data', (chunk: string) => this.receive(chunk));
        input.on('end', () => this.close(new Error('acp_agent_exited')));
        input.on('error', () => this.close(new Error('acp_agent_exited')));
        output.on('error', () => this.close(new Error('acp_agent_exited')));
    }

    get closed() { return this.closedWith !== null; }

    request(method: string, params: unknown, timeoutMs?: number): Promise<any> {
        if (this.closedWith) return Promise.reject(this.closedWith);
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const entry: { resolve(v: unknown): void; reject(e: unknown): void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
            if (timeoutMs) entry.timer = setTimeout(() => { this.pending.delete(id); reject(new Error('acp_rpc_timeout')); }, timeoutMs);
            this.pending.set(id, entry);
            this.send({ jsonrpc: '2.0', id, method, params });
        });
    }

    notify(method: string, params: unknown) {
        if (!this.closedWith) this.send({ jsonrpc: '2.0', method, params });
    }

    /** Reject everything still waiting; later input is ignored. */
    close(reason: Error) {
        if (this.closedWith) return;
        this.closedWith = reason; this.buffer = '';
        for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(reason); this.pending.delete(id); }
    }

    private send(message: object) {
        try { this.output.write(`${JSON.stringify(message)}\n`); } catch { this.close(new Error('acp_agent_exited')); }
    }

    private receive(chunk: string) {
        if (this.closedWith) return;
        this.buffer += chunk;
        let newline: number;
        while ((newline = this.buffer.indexOf('\n')) >= 0) {
            const line = this.buffer.slice(0, newline).trim();
            this.buffer = this.buffer.slice(newline + 1);
            if (line) this.dispatch(line);
            if (this.closedWith) return;
        }
        if (this.buffer.length > this.maxLine) this.close(new Error('acp_output_limit'));
    }

    private dispatch(line: string) {
        let message: any;
        try { message = JSON.parse(line); } catch { this.close(new Error('acp_invalid_output')); return; }
        if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0') { this.close(new Error('acp_invalid_output')); return; }
        if (typeof message.method === 'string') {
            if ('id' in message) {
                if (!isId(message.id)) { this.close(new Error('acp_invalid_output')); return; }
                void this.answer(message.id, message.method, message.params);
            } else {
                try { this.handlers.notification(message.method, message.params); } catch { /* a bad update never ends the run */ }
            }
            return;
        }
        const p = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
        if (!p) return; // a late answer to a timed-out request
        this.pending.delete(message.id); clearTimeout(p.timer);
        if (message.error && typeof message.error === 'object') {
            const e = message.error;
            p.reject(new RpcError(Number.isInteger(e.code) ? e.code : -32603, typeof e.message === 'string' ? e.message.slice(0, 2000) : '', e.data));
        } else p.resolve(message.result ?? null);
    }

    private async answer(id: Id, method: string, params: unknown) {
        try {
            const result = await this.handlers.request(method, params);
            this.send({ jsonrpc: '2.0', id, result: result ?? null });
        } catch (err) {
            const e = err instanceof RpcError ? err : new RpcError(-32603, 'Internal error');
            this.send({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message } });
        }
    }
}
