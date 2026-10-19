import { generateUlid } from '../utils/ulid';
import { postNotice, type Notice } from './agent-runs';

export interface CheckpointReport { sha: string; ref: string }
export const checkpointSchema = { type: 'object', additionalProperties: false, required: ['sha','ref'], properties: {
    sha: { type: 'string', pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' },
    ref: { type: 'string', pattern: '^refs/agora/checkpoints/[0-9A-HJKMNP-TV-Z]{26}/[1-9][0-9]*$', maxLength: 128 },
} } as const;
export async function recordCheckpoint(db: any, run: any, cp: CheckpointReport | undefined, notices: Notice[]) {
    if (!cp) return true;
    const sessionId = run.session_id.trim();
    if (!new RegExp(`^refs/agora/checkpoints/${sessionId}/[1-9][0-9]*$`).test(cp.ref)) return false;
    const s = (await db.query(`SELECT s.channel_id,p.generation FROM agent_sessions s JOIN agent_profiles p ON p.id=s.profile_id WHERE s.id=$1`, [sessionId])).rows[0];
    if (!s || s.generation !== run.profile_generation) return false;
    const trigger = (await db.query('SELECT message_id FROM agent_inbox WHERE batch_id=$1 ORDER BY created_at,id LIMIT 1', [run.batch_id])).rows[0]?.message_id ?? null;
    const inserted = await db.query(`INSERT INTO agent_checkpoints (id,session_id,run_id,message_id,sha,ref)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (run_id) DO NOTHING RETURNING id`, [generateUlid(),sessionId,run.id,trigger,cp.sha,cp.ref]);
    if (inserted.rows.length) notices.push(await postNotice(db,s.channel_id.trim(),`Checkpoint ${cp.ref.split('/').pop()} saved for session ${sessionId}, run ${run.id.trim()}${trigger ? `, message ${trigger.trim()}` : ''}.`));
    return true;
}
