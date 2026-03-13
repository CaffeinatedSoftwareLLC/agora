import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { generateUlid } from '../utils/ulid';
import { Permissions, computePermissions } from '../permissions';
import { loadAndComputePermissions } from './bots';

// ─── PreHandler: require ManageRoles permission ───

async function requireManageRoles(request: FastifyRequest, reply: FastifyReply) {
    if (request.isBot) {
        return reply.status(403).send({ error: 'Bots cannot manage roles' });
    }
    const { serverId } = request.params as any;
    const userId = request.userId;
    const db = request.dbClient!;

    const member = await db.query(
        'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    if (member.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this server' });
    }

    const perms = await loadAndComputePermissions(db, userId, serverId);
    if (!(perms & Permissions.ManageRoles) && !(perms & Permissions.Administrator)) {
        return reply.status(403).send({ error: 'Missing ManageRoles permission' });
    }
}

/**
 * Privilege escalation guard: reject if the target role has permissions
 * the caller doesn't have (unless caller is server owner or Administrator).
 */
async function checkEscalation(
    db: any,
    callerPerms: bigint,
    rolePermissions: bigint,
    serverId: string,
    callerId: string,
): Promise<string | null> {
    // Server owner can always set any permission
    const server = await db.query('SELECT owner_id FROM servers WHERE id = $1', [serverId]);
    if (server.rows[0]?.owner_id?.trim() === callerId.trim()) return null;
    // Administrator can always set any permission
    if (callerPerms & Permissions.Administrator) return null;

    const escalated = rolePermissions & ~callerPerms;
    if (escalated !== 0n) {
        return 'Cannot assign permissions you do not have';
    }
    return null;
}

// ─── PreHandler for channel overrides: membership + ManageRoles ───

async function requireManageRolesForChannel(request: FastifyRequest, reply: FastifyReply) {
    if (request.isBot) {
        return reply.status(403).send({ error: 'Bots cannot manage channel overrides' });
    }
    const { channelId } = request.params as any;
    const userId = request.userId;
    const db = request.dbClient!;

    const channelRow = await db.query(
        'SELECT server_id FROM channels WHERE id = $1',
        [channelId]
    );
    if (!channelRow.rows[0]) {
        return reply.status(404).send({ error: 'Channel not found' });
    }
    if (!channelRow.rows[0].server_id) {
        return reply.status(400).send({ error: 'Cannot set overrides on DM channels' });
    }

    const serverId = channelRow.rows[0].server_id.trim();

    const member = await db.query(
        'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    if (member.rows.length === 0) {
        return reply.status(403).send({ error: 'Not a member of this server' });
    }

    const perms = await loadAndComputePermissions(db, userId, serverId);
    if (!(perms & Permissions.ManageRoles) && !(perms & Permissions.Administrator)) {
        return reply.status(403).send({ error: 'Missing ManageRoles permission' });
    }

    // Stash serverId + perms for route handler
    (request as any)._serverId = serverId;
    (request as any)._callerPerms = perms;
}

export async function roleRoutes(app: FastifyInstance) {

    // ─── Role CRUD ───

    // GET /servers/:serverId/roles → 200 [{ id, name, color, hoist, position, permissions, mentionable, isEveryone }]
    app.get('/servers/:serverId/roles', {
        preHandler: [requireManageRoles],
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const db = request.dbClient!;

        const result = await db.query(
            `SELECT id, name, color, hoist, position, permissions, mentionable, is_everyone, created_at
             FROM roles
             WHERE server_id = $1
             ORDER BY position ASC, created_at ASC`,
            [serverId]
        );

        const roles = result.rows.map((r: any) => ({
            id: r.id.trim(),
            name: r.name,
            color: r.color,
            hoist: r.hoist,
            position: r.position,
            permissions: r.permissions.toString(),
            mentionable: r.mentionable,
            isEveryone: r.is_everyone,
            createdAt: r.created_at,
        }));

        return reply.status(200).send(roles);
    });

    // POST /servers/:serverId/roles → 201 { id, name, ... }
    app.post('/servers/:serverId/roles', {
        preHandler: [requireManageRoles],
        schema: {
            body: {
                type: 'object',
                required: ['name'],
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 64 },
                    color: { type: 'string', maxLength: 7 },
                    hoist: { type: 'boolean' },
                    permissions: { type: 'string' },
                    mentionable: { type: 'boolean' },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;
        const { name, color, hoist, permissions: permsStr, mentionable } = request.body as any;

        const rolePerms = permsStr ? BigInt(permsStr) : 0n;

        // Privilege escalation check
        const callerPerms = await loadAndComputePermissions(db, userId, serverId);
        const err = await checkEscalation(db, callerPerms, rolePerms, serverId, userId);
        if (err) return reply.status(403).send({ error: err });

        // Get max position for ordering
        const posResult = await db.query(
            'SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM roles WHERE server_id = $1',
            [serverId]
        );
        const nextPos = posResult.rows[0].next_pos;

        const roleId = generateUlid();

        try {
            await db.query(
                `INSERT INTO roles (id, server_id, name, color, hoist, position, permissions, mentionable)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [roleId, serverId, name, color || null, hoist ?? false, nextPos, rolePerms.toString(), mentionable ?? false]
            );
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'A role with that name already exists' });
            }
            throw err;
        }

        return reply.status(201).send({
            id: roleId.trim(),
            name,
            color: color || null,
            hoist: hoist ?? false,
            position: nextPos,
            permissions: rolePerms.toString(),
            mentionable: mentionable ?? false,
            isEveryone: false,
        });
    });

    // PATCH /servers/:serverId/roles/:roleId → 200 { id, name, ... }
    app.patch('/servers/:serverId/roles/:roleId', {
        preHandler: [requireManageRoles],
        schema: {
            body: {
                type: 'object',
                properties: {
                    name: { type: 'string', minLength: 1, maxLength: 64 },
                    color: { type: ['string', 'null'], maxLength: 7 },
                    hoist: { type: 'boolean' },
                    permissions: { type: 'string' },
                    mentionable: { type: 'boolean' },
                    position: { type: 'integer', minimum: 0 },
                },
            },
        },
    }, async (request, reply) => {
        const { serverId, roleId } = request.params as any;
        const userId = request.userId;
        const db = request.dbClient!;
        const body = request.body as any;

        const existing = await db.query(
            'SELECT * FROM roles WHERE id = $1 AND server_id = $2',
            [roleId, serverId]
        );
        if (!existing.rows[0]) {
            return reply.status(404).send({ error: 'Role not found' });
        }

        const role = existing.rows[0];

        // Cannot rename @everyone
        if (role.is_everyone && body.name && body.name !== role.name) {
            return reply.status(400).send({ error: 'Cannot rename the @everyone role' });
        }

        // Privilege escalation check on new permissions
        if (body.permissions !== undefined) {
            const newPerms = BigInt(body.permissions);
            const callerPerms = await loadAndComputePermissions(db, userId, serverId);
            const err = await checkEscalation(db, callerPerms, newPerms, serverId, userId);
            if (err) return reply.status(403).send({ error: err });
        }

        // Build SET clause dynamically
        const sets: string[] = [];
        const vals: any[] = [];
        let idx = 1;

        if (body.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(body.name); }
        if (body.color !== undefined) { sets.push(`color = $${idx++}`); vals.push(body.color); }
        if (body.hoist !== undefined) { sets.push(`hoist = $${idx++}`); vals.push(body.hoist); }
        if (body.permissions !== undefined) { sets.push(`permissions = $${idx++}`); vals.push(body.permissions); }
        if (body.mentionable !== undefined) { sets.push(`mentionable = $${idx++}`); vals.push(body.mentionable); }
        if (body.position !== undefined) { sets.push(`position = $${idx++}`); vals.push(body.position); }

        if (sets.length === 0) {
            return reply.status(400).send({ error: 'No fields to update' });
        }

        vals.push(roleId);
        vals.push(serverId);

        try {
            await db.query(
                `UPDATE roles SET ${sets.join(', ')} WHERE id = $${idx++} AND server_id = $${idx}`,
                vals
            );
        } catch (err: any) {
            if (err.code === '23505') {
                return reply.status(409).send({ error: 'A role with that name already exists' });
            }
            throw err;
        }

        // Return updated role
        const updated = await db.query(
            'SELECT * FROM roles WHERE id = $1',
            [roleId]
        );
        const r = updated.rows[0];

        return reply.status(200).send({
            id: r.id.trim(),
            name: r.name,
            color: r.color,
            hoist: r.hoist,
            position: r.position,
            permissions: r.permissions.toString(),
            mentionable: r.mentionable,
            isEveryone: r.is_everyone,
        });
    });

    // DELETE /servers/:serverId/roles/:roleId → 200 { deleted: true }
    app.delete('/servers/:serverId/roles/:roleId', {
        preHandler: [requireManageRoles],
    }, async (request, reply) => {
        const { serverId, roleId } = request.params as any;
        const db = request.dbClient!;

        // Check if it's @everyone
        const role = await db.query(
            'SELECT is_everyone FROM roles WHERE id = $1 AND server_id = $2',
            [roleId, serverId]
        );
        if (!role.rows[0]) {
            return reply.status(404).send({ error: 'Role not found' });
        }
        if (role.rows[0].is_everyone) {
            return reply.status(400).send({ error: 'Cannot delete the @everyone role' });
        }

        await db.query(
            'DELETE FROM roles WHERE id = $1 AND server_id = $2',
            [roleId, serverId]
        );

        return reply.status(200).send({ deleted: true });
    });

    // ─── Role Assignment ───

    // PUT /servers/:serverId/members/:userId/roles/:roleId → 200 { assigned: true }
    app.put('/servers/:serverId/members/:userId/roles/:roleId', {
        preHandler: [requireManageRoles],
    }, async (request, reply) => {
        const { serverId, userId: targetUserId, roleId } = request.params as any;
        const callerId = request.userId;
        const db = request.dbClient!;

        // Verify role belongs to this server and is not @everyone
        const role = await db.query(
            'SELECT is_everyone, permissions FROM roles WHERE id = $1 AND server_id = $2',
            [roleId, serverId]
        );
        if (!role.rows[0]) {
            return reply.status(404).send({ error: 'Role not found' });
        }
        if (role.rows[0].is_everyone) {
            return reply.status(400).send({ error: 'Cannot manually assign the @everyone role' });
        }

        // Verify target is a member
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, targetUserId]
        );
        if (member.rows.length === 0) {
            return reply.status(404).send({ error: 'User is not a member of this server' });
        }

        // Escalation check: can't assign a role with perms you don't have
        const rolePerms = BigInt(role.rows[0].permissions);
        const callerPerms = await loadAndComputePermissions(db, callerId, serverId);
        const err = await checkEscalation(db, callerPerms, rolePerms, serverId, callerId);
        if (err) return reply.status(403).send({ error: err });

        try {
            await db.query(
                'INSERT INTO member_roles (server_id, user_id, role_id) VALUES ($1, $2, $3)',
                [serverId, targetUserId, roleId]
            );
        } catch (err: any) {
            if (err.code === '23505') {
                // Already assigned — idempotent success
                return reply.status(200).send({ assigned: true });
            }
            throw err;
        }

        return reply.status(200).send({ assigned: true });
    });

    // DELETE /servers/:serverId/members/:userId/roles/:roleId → 200 { removed: true }
    app.delete('/servers/:serverId/members/:userId/roles/:roleId', {
        preHandler: [requireManageRoles],
    }, async (request, reply) => {
        const { serverId, userId: targetUserId, roleId } = request.params as any;
        const db = request.dbClient!;

        const result = await db.query(
            'DELETE FROM member_roles WHERE server_id = $1 AND user_id = $2 AND role_id = $3 RETURNING role_id',
            [serverId, targetUserId, roleId]
        );
        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'Role assignment not found' });
        }

        return reply.status(200).send({ removed: true });
    });

    // ─── Channel Permission Overrides ───

    // GET /channels/:channelId/overrides → 200 { roles: [...], members: [...] }
    app.get('/channels/:channelId/overrides', {
        preHandler: [requireManageRolesForChannel],
    }, async (request, reply) => {
        const { channelId } = request.params as any;
        const db = request.dbClient!;

        const roleOverrides = await db.query(
            `SELECT cro.role_id, cro.allow, cro.deny, r.name AS role_name
             FROM channel_role_overrides cro
             JOIN roles r ON r.id = cro.role_id
             WHERE cro.channel_id = $1
             ORDER BY r.position`,
            [channelId]
        );

        const memberOverrides = await db.query(
            `SELECT cmo.user_id, cmo.allow, cmo.deny, u.username
             FROM channel_member_overrides cmo
             JOIN users u ON u.id = cmo.user_id
             WHERE cmo.channel_id = $1
             ORDER BY u.username`,
            [channelId]
        );

        return reply.status(200).send({
            roles: roleOverrides.rows.map((r: any) => ({
                roleId: r.role_id.trim(),
                roleName: r.role_name,
                allow: r.allow.toString(),
                deny: r.deny.toString(),
            })),
            members: memberOverrides.rows.map((r: any) => ({
                userId: r.user_id.trim(),
                username: r.username,
                allow: r.allow.toString(),
                deny: r.deny.toString(),
            })),
        });
    });

    // PUT /channels/:channelId/overrides/roles/:roleId → 200 { roleId, allow, deny }
    app.put('/channels/:channelId/overrides/roles/:roleId', {
        preHandler: [requireManageRolesForChannel],
        schema: {
            body: {
                type: 'object',
                required: ['allow', 'deny'],
                properties: {
                    allow: { type: 'string' },
                    deny: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { channelId, roleId } = request.params as any;
        const { allow, deny } = request.body as any;
        const db = request.dbClient!;
        const serverId = (request as any)._serverId;
        const callerPerms = (request as any)._callerPerms as bigint;
        const userId = request.userId;

        // Verify role belongs to the server
        const role = await db.query(
            'SELECT 1 FROM roles WHERE id = $1 AND server_id = $2',
            [roleId, serverId]
        );
        if (!role.rows[0]) {
            return reply.status(404).send({ error: 'Role not found in this server' });
        }

        // Escalation check on the allow bits
        const allowBits = BigInt(allow);
        const err = await checkEscalation(db, callerPerms, allowBits, serverId, userId);
        if (err) return reply.status(403).send({ error: err });

        await db.query(
            `INSERT INTO channel_role_overrides (channel_id, role_id, allow, deny)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (channel_id, role_id) DO UPDATE
                SET allow = $3, deny = $4`,
            [channelId, roleId, allow, deny]
        );

        return reply.status(200).send({
            roleId: roleId.trim(),
            allow,
            deny,
        });
    });

    // DELETE /channels/:channelId/overrides/roles/:roleId → 200 { removed: true }
    app.delete('/channels/:channelId/overrides/roles/:roleId', {
        preHandler: [requireManageRolesForChannel],
    }, async (request, reply) => {
        const { channelId, roleId } = request.params as any;
        const db = request.dbClient!;

        const result = await db.query(
            'DELETE FROM channel_role_overrides WHERE channel_id = $1 AND role_id = $2 RETURNING role_id',
            [channelId, roleId]
        );
        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'Override not found' });
        }

        return reply.status(200).send({ removed: true });
    });

    // PUT /channels/:channelId/overrides/members/:userId → 200 { userId, allow, deny }
    app.put('/channels/:channelId/overrides/members/:userId', {
        preHandler: [requireManageRolesForChannel],
        schema: {
            body: {
                type: 'object',
                required: ['allow', 'deny'],
                properties: {
                    allow: { type: 'string' },
                    deny: { type: 'string' },
                },
            },
        },
    }, async (request, reply) => {
        const { channelId, userId: targetUserId } = request.params as any;
        const { allow, deny } = request.body as any;
        const db = request.dbClient!;
        const serverId = (request as any)._serverId;
        const callerPerms = (request as any)._callerPerms as bigint;
        const callerId = request.userId;

        // Verify target is a member
        const member = await db.query(
            'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
            [serverId, targetUserId]
        );
        if (member.rows.length === 0) {
            return reply.status(404).send({ error: 'User is not a member of this server' });
        }

        // Escalation check
        const allowBits = BigInt(allow);
        const err = await checkEscalation(db, callerPerms, allowBits, serverId, callerId);
        if (err) return reply.status(403).send({ error: err });

        await db.query(
            `INSERT INTO channel_member_overrides (channel_id, user_id, allow, deny)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (channel_id, user_id) DO UPDATE
                SET allow = $3, deny = $4`,
            [channelId, targetUserId, allow, deny]
        );

        return reply.status(200).send({
            userId: targetUserId.trim(),
            allow,
            deny,
        });
    });

    // DELETE /channels/:channelId/overrides/members/:userId → 200 { removed: true }
    app.delete('/channels/:channelId/overrides/members/:userId', {
        preHandler: [requireManageRolesForChannel],
    }, async (request, reply) => {
        const { channelId, userId: targetUserId } = request.params as any;
        const db = request.dbClient!;

        const result = await db.query(
            'DELETE FROM channel_member_overrides WHERE channel_id = $1 AND user_id = $2 RETURNING user_id',
            [channelId, targetUserId]
        );
        if (result.rows.length === 0) {
            return reply.status(404).send({ error: 'Override not found' });
        }

        return reply.status(200).send({ removed: true });
    });
}
