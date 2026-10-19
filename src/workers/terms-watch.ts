import type { Pool, PoolClient } from 'pg';
import { fetchTerms, termsHash, termsDiff } from '../lib/terms-fetch';
import { analyzeTerms } from '../terms/analysis';
import { generateUlid } from '../utils/ulid';
import type { Notice } from '../lib/agent-runs';

export interface TermsDocument { id: string; name: string; provider: string; url: string; allowed_hosts: string[]; snapshot_text: string | null; snapshot_hash: string | null }
export interface TermsDeps {
    db: Pool;
    fetcher?: (doc: TermsDocument) => Promise<string>;
    emit?: (notice: Notice) => void;
    log?: { warn(obj: unknown, msg: string): void };
}
export async function termsOwnerServer(db: { query: PoolClient['query'] }): Promise<string | null> {
    const r = await db.query(`SELECT s.id FROM servers s WHERE s.owner_id =
        (SELECT id FROM users WHERE is_instance_admin AND NOT bot ORDER BY created_at, id LIMIT 1)
        ORDER BY s.created_at, s.id LIMIT 1`);
    return r.rows[0]?.id.trim() ?? null;
}
export async function termsAlertChannel(db: PoolClient): Promise<string | null> {
    const serverId = await termsOwnerServer(db);
    const r = await db.query(`SELECT c.id FROM channels c JOIN servers s ON s.id=c.server_id
        WHERE c.channel_type=3 AND s.owner_id =
          (SELECT id FROM users WHERE is_instance_admin AND NOT bot ORDER BY created_at, id LIMIT 1)
        AND (c.id::text = (SELECT value #>> '{}' FROM instance_settings WHERE key='terms_watch.channel_id')
          OR (c.server_id=$1 AND c.name='general'))
        ORDER BY (c.id::text = (SELECT value #>> '{}' FROM instance_settings WHERE key='terms_watch.channel_id')) DESC NULLS LAST,
            c.created_at, c.id LIMIT 1`, [serverId]);
    return r.rows[0]?.id.trim() ?? null;
}

async function noticesForChanges(c: PoolClient): Promise<Notice[]> {
    const channelId = await termsAlertChannel(c); if (!channelId) return [];
    const changes = await c.query(`SELECT ch.id, d.name, ch.impact, ch.summary FROM terms_changes ch
        JOIN terms_documents d ON d.id=ch.document_id WHERE ch.notice_id IS NULL ORDER BY ch.created_at, ch.id LIMIT 100`);
    const notices: Notice[] = [];
    for (const change of changes.rows) {
        const id = generateUlid();
        // Remote names and model output are inert text. No mentions or links from the model.
        const plain = (v: string) => v.replace(/[@<>\[\]`*_\\]/g, '').replace(/https?:\/\/\S+/g, '[link removed]');
        const content = `Provider terms: ${plain(change.name)} — ${change.impact}\n${plain(change.summary)}\nReview: /admin/provider-terms`;
        const msg = await c.query(`INSERT INTO messages (id, channel_id, author_id, content, system_event)
            VALUES ($1,$2,NULL,$3,'provider_terms') RETURNING created_at`, [id, channelId, content]);
        await c.query('UPDATE channels SET last_message_id=$1 WHERE id=$2', [id, channelId]);
        await c.query('UPDATE terms_changes SET notice_id=$1 WHERE id=$2', [id, change.id.trim()]);
        notices.push({ channelId, event: { id, channelId, authorId: null, authorUsername: null, content,
            systemEvent: 'provider_terms', createdAt: msg.rows[0].created_at.toISOString() } });
    }
    return notices;
}

/** Session lock prevents overlapping scheduled/manual runs across API processes. */
export async function runTermsCheck(deps: TermsDeps, force = false): Promise<{ ran: boolean; checked: number }> {
    const c = await deps.db.connect(); let locked = false; let checked = 0;
    try {
        locked = (await c.query("SELECT pg_try_advisory_lock(hashtext('terms_watch')) AS locked")).rows[0].locked;
        if (!locked) return { ran: false, checked };
        const settings = Object.fromEntries((await c.query("SELECT key, value FROM instance_settings WHERE key LIKE 'terms_watch.%'")).rows.map(r => [r.key, r.value]));
        const interval = Number(settings['terms_watch.interval_hours'] ?? 24);
        const due = !settings['terms_watch.last_run_at'] || Date.now() - Date.parse(settings['terms_watch.last_run_at']) >= interval * 3600_000;
        if (!force && !due && !settings['terms_watch.requested']) return { ran: false, checked };
        await c.query(`INSERT INTO instance_settings (key,value) VALUES ('terms_watch.last_run_at',to_jsonb(now())),('terms_watch.requested','false')
            ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`);
        const docs = await c.query('SELECT * FROM terms_documents WHERE enabled ORDER BY id');
        const serverId = await termsOwnerServer(c);
        for (const row of docs.rows) {
            const doc: TermsDocument = { ...row, id: row.id.trim() };
            let text: string;
            try {
                text = await (deps.fetcher ?? (d => fetchTerms(d.url, d.allowed_hosts)))(doc);
                if (!text.trim()) throw new Error('Document has no readable text');
            } catch (err) {
                await c.query(`UPDATE terms_documents SET checked_at=now(), status='error', error=$2,
                    consecutive_failures=consecutive_failures+1 WHERE id=$1 AND enabled`,
                [doc.id, (err instanceof Error ? err.message : 'Fetch failed').slice(0, 500)]);
                checked++; continue;
            }
            const hash = termsHash(text);
            const diff = doc.snapshot_hash && doc.snapshot_hash !== hash ? termsDiff(doc.snapshot_text ?? '', text) : '';
            const analysis = diff ? await analyzeTerms(c, serverId, doc.provider, diff) : null;
            let notices: Notice[] = [];
            await c.query('BEGIN');
            try {
                // An admin may have disabled/removed the entry while it was fetched.
                const current = await c.query('SELECT enabled FROM terms_documents WHERE id=$1 FOR UPDATE', [doc.id]);
                if (current.rows[0]?.enabled) {
                    await c.query(`UPDATE terms_documents SET snapshot_text=$2,snapshot_hash=$3,fetched_at=now(),checked_at=now(),
                        status='ok',error=NULL,consecutive_failures=0 WHERE id=$1`, [doc.id, text, hash]);
                    if (analysis) await c.query(`INSERT INTO terms_changes
                        (id,document_id,previous_hash,current_hash,diff,summary,impact,analysis_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [generateUlid(), doc.id, doc.snapshot_hash, hash, diff, analysis.summary, analysis.impact, analysis.status]);
                }
                notices = await noticesForChanges(c);
                await c.query('COMMIT');
            } catch (err) { await c.query('ROLLBACK'); throw err; }
            // Events only after the snapshot, change and notice have committed together.
            for (const notice of notices) { try { deps.emit?.(notice); } catch (err) { deps.log?.warn({ err }, 'Terms notice event failed'); } }
            checked++;
        }
        // A channel may have been configured since the change, even if every URL
        // is now disabled or failing. Deliver those durable pending notices too.
        await c.query('BEGIN');
        let pending: Notice[];
        try { pending = await noticesForChanges(c); await c.query('COMMIT'); }
        catch (err) { await c.query('ROLLBACK'); throw err; }
        for (const notice of pending) { try { deps.emit?.(notice); } catch (err) { deps.log?.warn({ err }, 'Terms notice event failed'); } }
        return { ran: true, checked };
    } finally {
        if (locked) await c.query("SELECT pg_advisory_unlock(hashtext('terms_watch'))").catch(() => {});
        c.release();
    }
}

export function startTermsWatchWorker(deps: TermsDeps): () => Promise<void> {
    let running: Promise<unknown> | null = null; let stopped = false;
    const tick = () => {
        if (running || stopped) return;
        running = runTermsCheck(deps).catch(err => deps.log?.warn({ err }, 'Terms check failed')).finally(() => { running = null; });
    };
    const timer = setInterval(tick, 60_000); timer.unref(); tick();
    return async () => { stopped = true; clearInterval(timer); await running; };
}
