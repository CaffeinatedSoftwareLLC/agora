import type supertest from 'supertest';
import type { Pool } from 'pg';
import { jevReply, type JevCall } from './decision-helpers';
import { storage } from '../src/lib/storage';
import { config } from '../src/config';
import type { TaggingDeps } from '../src/workers/file-tagging';

/** Helpers for file tagging and file search tests. The decision model is always a stub. */

export const taggingDeps = (db: Pool, over: Partial<TaggingDeps> = {}): TaggingDeps =>
    ({ db, store: storage, encryptionKey: config.encryptionKey, ...over });

/** Upload a file through the API. Returns its id. */
export async function upload(req: supertest.Agent, auth: object, channelId: string, name: string, content: string | Buffer): Promise<string> {
    const res = await req.post('/files/upload').set(auth)
        .field('channel_id', channelId)
        .attach('file', Buffer.isBuffer(content) ? content : Buffer.from(content), name);
    if (res.status !== 201) throw new Error(`upload(${name}) failed: ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.id as string;
}

/** Upload a file and post it in a message, as a person sharing a file does. */
export async function share(req: supertest.Agent, auth: object, channelId: string, name: string, content: string | Buffer): Promise<string> {
    const id = await upload(req, auth, channelId, name, content);
    const msg = await req.post(`/channels/${channelId}/messages`).set(auth).send({ content: `shared ${name}`, attachments: [id] });
    if (msg.status !== 201) throw new Error(`share(${name}) failed: ${msg.status} ${JSON.stringify(msg.body)}`);
    return id;
}

/** The tag a tagging or tag-relevance question is about, read from its wording. */
export function tagNameOf(question: any): string | null {
    const match = /tag(?:ged)? "([^"]+)"/.exec(JSON.stringify(question.instructions).replace(/\\"/g, '"'));
    return match ? match[1] : null;
}

/**
 * Answer a tagging call: each tag question gets `rules[tagName](document)`, or 0.02
 * when there is no rule. The injection question gets 0.99 if the document carries
 * the marker "ignore all previous", else 0.01.
 */
export function tagAnswers(rules: Record<string, (document: string) => number>) {
    return (call: JevCall) => {
        const document = String(call.state.document ?? '');
        const answers: Record<string, number> = {};
        for (const [id, q] of Object.entries(call.questions)) {
            if (id === 'injection') {
                answers[id] = document.includes('ignore all previous') ? 0.99 : 0.01;
                continue;
            }
            const name = tagNameOf(q);
            answers[id] = name && rules[name] ? rules[name](document) : 0.02;
        }
        return jevReply(answers);
    };
}

/** A tag applies when the document contains the word. */
export const has = (word: string) => (document: string) => (document.toLowerCase().includes(word) ? 0.95 : 0.03);

export async function jobOf(db: Pool, fileId: string) {
    return (await db.query('SELECT * FROM file_tag_jobs WHERE file_id = $1', [fileId])).rows[0];
}

/** `{ tagName: probability }` for a file, rounded to two decimals. */
export async function tagsOf(db: Pool, fileId: string): Promise<Record<string, number>> {
    const res = await db.query(
        `SELECT t.name, ft.probability FROM file_tags ft JOIN file_tag_definitions t ON t.id = ft.tag_id WHERE ft.file_id = $1`,
        [fileId]
    );
    return Object.fromEntries(res.rows.map((r: any) => [r.name, Math.round(Number(r.probability) * 100) / 100]));
}
