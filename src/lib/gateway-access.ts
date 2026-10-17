import type { Pool } from 'pg';
import type { Server, Socket } from 'socket.io';
import { canViewChannel } from './channel-access';
import { isTokenBlacklisted } from '../auth/token-blacklist';

const revisions = new WeakMap<Server, number>();
export const gatewayAccessRevision = (io: Server): number => revisions.get(io) ?? 0;
export function invalidateGatewayAccess(io: Server): void {
    revisions.set(io, gatewayAccessRevision(io) + 1);
}

/** Shared by handshake and live-socket revalidation. Missing owners fail closed. */
export async function socketAccountError(db: Pool, userId: string, isBot: boolean, tokenVersion = 0): Promise<string | null> {
    const result = await db.query(
        `SELECT u.account_status, u.token_version, u.bot_paused_at, o.account_status AS owner_status
         FROM users u LEFT JOIN users o ON o.id = u.bot_owner_id
         WHERE u.id = $1 AND u.bot = $2`, [userId, isBot]);
    const user = result.rows[0];
    if (!user) return 'Invalid token';
    if (!isBot && tokenVersion !== user.token_version) return 'Token revoked';
    if (user.account_status !== 'active') return `account_${user.account_status}`;
    if (isBot && user.bot_paused_at) return 'bot_paused';
    if (isBot && user.owner_status !== 'active') return 'bot_owner_inactive';
    return null;
}

export async function visibleChannels<T extends { id: string }>(db: Pick<Pool, 'query'>, channels: T[], userId: string, isBot = false): Promise<T[]> {
    const visible: T[] = [];
    for (const channel of channels) {
        if ((await canViewChannel(db, channel.id.trim(), userId, isBot)).allowed) visible.push(channel);
    }
    return visible;
}

/** Revalidate after committed authorization changes, before returning success. */
export async function refreshGatewayAccess(io: Server, db: Pool): Promise<void> {
    for (const socket of io.sockets.sockets.values()) {
        try {
            const { userId, isBot } = socket.data;
            if (!userId) continue;
            let error = await socketAccountError(db, userId, !!isBot, socket.data.tokenVersion ?? 0);
            if (!error && !isBot && socket.data.jti && await isTokenBlacklisted(socket.data.jti)) error = 'Token revoked';
            if (!error && !isBot && socket.data.tokenExpiresAt <= Date.now()) error = 'token_expired';
            if (!error && isBot) {
                const token = await db.query('SELECT 1 FROM bot_tokens WHERE id = $1 AND bot_id = $2 AND revoked_at IS NULL', [socket.data.botTokenId, userId]);
                if (!token.rows.length) error = 'Token revoked';
            }
            if (!error) {
                for (const room of socket.rooms) {
                    if (room.startsWith('channel:') && !(await canViewChannel(db, room.slice(8), userId, !!isBot)).allowed) {
                        error = 'channel_access_revoked';
                        break;
                    }
                }
            }
            if (error) disconnectForAccess(socket, error);
        } catch {
            disconnectForAccess(socket, 'authorization_unavailable');
        }
    }
}

function disconnectForAccess(socket: Socket, code: string) {
    socket.emit('error', { code });
    socket.disconnect(true);
}

/** All authorization-bearing route families, including future membership routes. */
export function changesGatewayAccess(method: string, route: string): boolean {
    return !['GET', 'HEAD', 'OPTIONS'].includes(method)
        && /^\/(servers|invites|admin|roles|users)(\/|$)|^\/channels\/[^/]+\/(overrides|bots)(\/|$)/.test(route);
}
