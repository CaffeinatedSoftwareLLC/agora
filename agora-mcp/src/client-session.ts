import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { mcpClientName } from './api.js';

/**
 * Who the MCP client is, and when its session has started, without depending on the
 * `initialize` handshake (#299). MCP revision 2026-07-28 removes `initialize`: each request
 * carries its protocol version and capabilities in `_meta`, and clients SHOULD name themselves
 * there too (`io.modelcontextprotocol/clientInfo`). Older clients still name themselves once,
 * in `initialize`, and then send `notifications/initialized`.
 *
 * The client name is what Agora binds the bot token to (#39, `X-Agora-Client`). It comes from,
 * in order:
 * 1. the newest request's `_meta` clientInfo (2026-07-28 clients);
 * 2. `initialize`'s clientInfo (every client today);
 * 3. `--client <name>` / `AGORA_CLIENT`, for a client that names itself in neither.
 * With none of these, requests name no client and Agora refuses a token already bound to one.
 *
 * The session starts (agora-mcp opens its socket) on `notifications/initialized`, or on the
 * first request that is not `initialize`, `ping` or `server/discover`, whichever comes first. A legacy client
 * sends nothing else before `initialized`, so it starts exactly as before; a stateless client
 * starts on its first real request, and the client name from that request's `_meta` is known
 * before its handler runs.
 */

export const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';

/**
 * Requests that don't start a session: the legacy handshake, liveness checks, and the
 * `server/discover` probe a dual-era client sends before falling back to `initialize`. Starting
 * on the probe would open the channel socket before Claude Code listens.
 */
const NOT_A_START = new Set(['initialize', 'ping', 'server/discover']);

export interface ClientSessionOptions {
    /** The clientInfo name from `initialize`, if the client sent one (`server.getClientVersion()?.name`). */
    initializeName: () => unknown;
    /** `--client` / `AGORA_CLIENT`; already validated with `configuredClientName`. */
    configured?: string | null;
    /** Called once, when the session starts. */
    onStart: () => void;
}

export class ClientSession {
    private metaName: string | null = null;
    private started = false;

    constructor(private opts: ClientSessionOptions) {}

    /** The client name to send to Agora, or null when the client has named itself nowhere. */
    name(): string | null {
        return this.metaName ?? mcpClientName(this.opts.initializeName()) ?? this.opts.configured ?? null;
    }

    get hasStarted(): boolean { return this.started; }

    /** Look at one incoming message before the SDK handles it. */
    observe(message: JSONRPCMessage): void {
        if (!('method' in message) || typeof message.method !== 'string') return;
        const params = (message as { params?: { _meta?: Record<string, unknown> } }).params;
        const info = params?._meta?.[CLIENT_INFO_META] as { name?: unknown } | undefined;
        const name = mcpClientName(info?.name);
        if (name) this.metaName = name;

        if (message.method === 'notifications/initialized') this.start();
        else if ('id' in message && !NOT_A_START.has(message.method)) this.start();
    }

    private start(): void {
        if (this.started) return;
        this.started = true;
        this.opts.onStart();
    }
}

/**
 * Route every message the transport receives through `session.observe` first. Call after
 * `server.connect(transport)`, which is when the SDK sets `transport.onmessage`.
 */
export function observeTransport(transport: Transport, session: ClientSession): void {
    const handle = transport.onmessage;
    if (!handle) throw new Error('observeTransport: connect the server to the transport first');
    transport.onmessage = ((message: JSONRPCMessage, extra?: unknown) => {
        try { session.observe(message); } catch (e) { process.stderr.write(`[agora-mcp] client session: ${e}\n`); }
        (handle as (m: JSONRPCMessage, x?: unknown) => void)(message, extra);
    }) as Transport['onmessage'];
}

/** `--client <name>` or `AGORA_CLIENT`. Throws on a name that could not be sent as a header. */
export function configuredClientName(args: string[], env: Record<string, string | undefined>): string | null {
    const i = args.indexOf('--client');
    const raw = i !== -1 ? args[i + 1] : env.AGORA_CLIENT;
    if (raw === undefined || raw === '') return null;
    const name = mcpClientName(raw);
    if (!name) throw new Error('--client (or AGORA_CLIENT) must be 1–100 printable ASCII characters.');
    return name;
}
