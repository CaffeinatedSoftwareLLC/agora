import { createHash, randomBytes } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { generateBotToken } from '../auth/bot-tokens';
import { loadAndComputePermissions } from './bots';
import { Permissions } from '../permissions';

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export async function agentInviteRoutes(app: FastifyInstance) {
    app.post('/servers/:serverId/agent-invites', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { body: {
            type: 'object', additionalProperties: false,
            oneOf: [{ required: ['botId'] }, { required: ['username'] }],
            properties: {
                botId: { type: 'string', pattern: '^[0-9A-HJKMNP-TV-Z]{26}$' },
                username: { type: 'string', minLength: 1, maxLength: 32, pattern: '\\S' },
            },
        } },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const { serverId } = request.params as { serverId: string };
        const { botId: existingBotId, username } = request.body as { botId?: string; username?: string };
        const db = request.dbClient!;
        if (request.isBot) return reply.code(403).send({ error: 'forbidden' });
        const member = await db.query('SELECT 1 FROM server_members WHERE server_id=$1 AND user_id=$2', [serverId, request.userId]);
        if (!member.rowCount) return reply.code(403).send({ error: 'forbidden' });
        const perms = await loadAndComputePermissions(db, request.userId, serverId);
        const admin = !!(perms & Permissions.Administrator);
        let botId = existingBotId;
        if (botId) {
            const bot = await db.query('SELECT bot_owner_id FROM users WHERE id=$1 AND server_id=$2 AND bot=true', [botId, serverId]);
            if (!bot.rowCount) return reply.code(404).send({ error: 'bot_not_found' });
            if (!admin && bot.rows[0].bot_owner_id?.trim() !== request.userId) return reply.code(403).send({ error: 'forbidden' });
        } else {
            if (!admin) return reply.code(403).send({ error: 'forbidden' });
            botId = generateUlid();
            const inserted = await db.query(
                `INSERT INTO users (id, username, bot, bot_owner_id, server_id)
                 VALUES ($1,$2,true,$3,$4) ON CONFLICT DO NOTHING RETURNING id`,
                [botId, username!.trim(), request.userId, serverId]);
            if (!inserted.rowCount) return reply.code(409).send({ error: 'Username already taken' });
            await db.query(`INSERT INTO bot_channel_access (bot_id, channel_id, granted_by)
                SELECT $1, id, $3 FROM channels WHERE server_id=$2 AND name='general' AND channel_type=3`, [botId, serverId, request.userId]);
        }
        const code = randomBytes(32).toString('hex');
        const id = generateUlid();
        const result = await db.query(`INSERT INTO agent_invites (id, code_hash, bot_id, server_id, created_by)
            VALUES ($1,$2,$3,$4,$5) RETURNING expires_at`, [id, hashCode(code), botId, serverId, request.userId]);
        await db.query(`INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
            VALUES ($1,$2,$3,'agent_invite_create','bot',$4,$5)`,
            [generateUlid(), serverId, request.userId, botId, JSON.stringify({ inviteId: id, ip: request.ip })]);
        return reply.code(201).send({ id, code, botId, expiresAt: result.rows[0].expires_at });
    });

    // Public exact route. Keep the secret out of request URLs and access logs.
    app.post('/agent-invites/redeem', {
        config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
        schema: { body: { type: 'object', additionalProperties: false, required: ['code'],
            properties: { code: { type: 'string', pattern: '^[a-f0-9]{64}$' } } } },
    }, async (request, reply) => {
        reply.header('Cache-Control', 'no-store');
        const db = request.dbClient!;
        const { code } = request.body as { code: string };
        // Rechecks the predicate after waiting for a concurrent updater's commit. The bot and
        // its owner must both be active, as for bot tokens; otherwise the invite is unusable.
        const redeemed = await db.query(`UPDATE agent_invites i SET redeemed_at=clock_timestamp()
            FROM users b JOIN users o ON o.id = b.bot_owner_id
            WHERE i.code_hash=$1 AND i.redeemed_at IS NULL AND i.expires_at > clock_timestamp()
              AND b.id = i.bot_id AND b.account_status = 'active' AND o.account_status = 'active'
            RETURNING i.id, i.bot_id, i.server_id`, [hashCode(code)]);
        if (!redeemed.rowCount) {
            await db.query(`INSERT INTO audit_log (id, action, target_type, changes)
                VALUES ($1,'agent_invite_redeem_failed','agent_invite',$2)`, [generateUlid(), JSON.stringify({ ip: request.ip })]);
            return reply.code(410).send({ error: 'invite_invalid_or_expired' });
        }
        const { id, bot_id, server_id } = redeemed.rows[0];
        const token = await generateBotToken();
        await db.query(`INSERT INTO bot_tokens (id, bot_id, secret_hash, name) VALUES ($1,$2,$3,'Agent invite')`,
            [token.tokenId, bot_id, token.secretHash]);
        await db.query(`INSERT INTO audit_log (id, server_id, actor_id, action, target_type, target_id, changes)
            VALUES ($1,$2,$3,'agent_invite_redeem','bot',$3,$4)`,
            [generateUlid(), server_id, bot_id, JSON.stringify({ inviteId: id.trim(), tokenId: token.tokenId, ip: request.ip })]);
        return { token: token.raw, botId: bot_id.trim() };
    });
}
