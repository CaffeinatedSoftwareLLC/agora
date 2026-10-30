import { generateUlid } from '../utils/ulid';

/**
 * Bot tokens bound to their client (issue #39). Every agent on a machine runs as the same
 * OS user, so one agent can read another's saved token. agora-mcp names the MCP client
 * that launched it (`clientInfo.name` from the initialize handshake: `claude-code`,
 * `codex-mcp-client`, …) in `X-Agora-Client`, or `auth.client` on the socket. The first
 * request that names a client binds the token to it; after that a request naming another
 * client, or none, is refused with a 403 that says which client the token belongs to.
 *
 * The name is the client's own claim and can be forged, so this stops an agent picking up
 * a token it found and makes the attempt visible (audit log, the token list); it does not
 * stop an agent set on impersonation. Tokens never used with a client name (scripts,
 * server-side model agents, older agora-mcp) stay unbound and are not restricted.
 *
 * The decision is a pure function of the binding and the claim, so it can move behind the
 * runtime Decider seam (src/runtime/decider.ts) later without changing callers.
 */

export const CLIENT_HEADER = 'x-agora-client';

/** Printable ASCII, 1–100 characters, no leading space. Anything else counts as no name. */
const CLIENT_NAME = /^[\x21-\x7E][\x20-\x7E]{0,99}$/;

/** A refusal for the same token and client is audited at most once per this window. */
const REFUSAL_AUDIT_MINUTES = 10;

/** The client a request names, or null. */
export function clientName(raw: unknown): string | null {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return null;
    const name = value.trim();
    return CLIENT_NAME.test(name) ? name : null;
}

export type TokenUse = { action: 'allow' } | { action: 'bind'; client: string } | { action: 'deny'; boundClient: string };

/** Same client, or nothing to bind: allow. First named client: bind. Bound and another (or no) client: deny. */
export function decideTokenUse(boundClient: string | null, presented: string | null): TokenUse {
    if (boundClient === null) return presented === null ? { action: 'allow' } : { action: 'bind', client: presented };
    return presented === boundClient ? { action: 'allow' } : { action: 'deny', boundClient };
}

export function refusalMessage(boundClient: string, presented: string | null): string {
    return `This bot token belongs to ${boundClient}${presented ? `, not ${presented}` : ''}. `
        + 'Use the Agora connection set up for you; if this agent has none, stop and ask your user. '
        + 'A bot owner or admin can clear the binding in the bot\'s settings.';
}

/** The token row columns `checkTokenUse` needs (select them with the token lookup). */
export const TOKEN_BINDING_COLUMNS = 't.bound_client, t.last_refused_at, t.last_refused_client';

export interface TokenUseInput {
    tokenId: string;
    botId: string;
    /** The bot's server, for the audit entry. */
    serverId: string | null;
    row: { bound_client: string | null; last_refused_at: Date | string | null; last_refused_client: string | null };
    client: string | null;
    ip: string | null;
    userAgent: string | null;
}

export type TokenUseResult = { ok: true } | { ok: false; boundClient: string; message: string };

const clip = (value: string | null, max: number) => (value === null ? null : value.slice(0, max));

/**
 * Apply the binding rule to one authenticated request or socket and record the use: the
 * client, address and user agent on success, a refusal (and an audit entry) otherwise.
 */
export async function checkTokenUse(db: { query: (sql: string, params?: unknown[]) => Promise<any> }, input: TokenUseInput): Promise<TokenUseResult> {
    const bound = input.row.bound_client?.trim() || null;
    const use = decideTokenUse(bound, input.client);
    const ip = clip(input.ip, 64);
    const userAgent = clip(input.userAgent, 200);

    if (use.action === 'deny') {
        await db.query(
            `UPDATE bot_tokens SET last_refused_at = NOW(), last_refused_client = $2, last_refused_ip = $3 WHERE id = $1`,
            [input.tokenId, input.client, ip]
        );
        const last = input.row.last_refused_at ? new Date(input.row.last_refused_at).getTime() : 0;
        const repeat = (input.row.last_refused_client ?? null) === input.client && Date.now() - last < REFUSAL_AUDIT_MINUTES * 60_000;
        if (!repeat) {
            await audit(db, input, 'bot_token_refused', { tokenId: input.tokenId, boundClient: use.boundClient, client: input.client, ip, userAgent });
        }
        return { ok: false, boundClient: use.boundClient, message: refusalMessage(use.boundClient, input.client) };
    }

    if (use.action === 'bind') {
        const bound = await db.query(
            `UPDATE bot_tokens SET bound_client = $2, bound_at = NOW(), last_used_at = NOW(),
                    last_used_client = $2, last_used_ip = $3, last_used_user_agent = $4
             WHERE id = $1 AND bound_client IS NULL RETURNING id`,
            [input.tokenId, use.client, ip, userAgent]
        );
        if (bound.rows.length === 0) {
            // Another request bound it first: decide again against that binding
            const now = await db.query(`SELECT ${TOKEN_BINDING_COLUMNS} FROM bot_tokens t WHERE t.id = $1`, [input.tokenId]);
            if (!now.rows[0]?.bound_client) return { ok: true };
            return checkTokenUse(db, { ...input, row: now.rows[0] });
        }
        await audit(db, input, 'bot_token_bound', { tokenId: input.tokenId, client: use.client, ip, userAgent });
        return { ok: true };
    }

    await db.query(
        `UPDATE bot_tokens SET last_used_at = NOW(), last_used_client = $2, last_used_ip = $3, last_used_user_agent = $4 WHERE id = $1`,
        [input.tokenId, input.client, ip, userAgent]
    );
    return { ok: true };
}

async function audit(db: { query: (sql: string, params?: unknown[]) => Promise<any> }, input: TokenUseInput, action: string, changes: Record<string, unknown>) {
    await db.query(
        `INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
         VALUES ($1, $2, $3, $4, 'bot', $3, $5)`,
        [generateUlid(), input.serverId, input.botId, action, JSON.stringify(changes)]
    );
}
