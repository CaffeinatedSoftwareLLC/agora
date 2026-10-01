import { generateUlid } from '../utils/ulid';
import type { TagQuestionSource } from '../ai/decision-questions';

/**
 * The tag vocabulary of a server (docs/planning/jev-wbs.md, C.1). A decision model
 * cannot write text, so it cannot invent tags: it answers one yes/no question per
 * tag in this list. Admins edit the list and each tag's criteria in AI settings.
 */

interface Queryable {
    query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/** Jev's limit on options per call, and a sane bound on cost per file. */
export const MAX_TAGS_PER_SERVER = 255;

export interface TagDefinition extends TagQuestionSource {
    id: string;
    revision: number;
    enabled: boolean;
}

/** What a server starts with. Admins can change or delete any of them. */
export const DEFAULT_TAGS: TagQuestionSource[] = [
    {
        name: 'protocol',
        instructions: 'Rules or steps that participants (people or agents) must follow when working together.',
        criteriaTrue: 'The document sets out a procedure, protocol, convention or rules of conduct to follow: turn-taking, message formats, how to hand off, what to do when.',
        criteriaFalse: 'The document describes a product, a plan or results, or only mentions that a protocol exists.',
    },
    {
        name: 'specification',
        instructions: 'A precise description of how something is built or must behave.',
        criteriaTrue: 'The document specifies requirements, an interface, a data model, an architecture or a design in enough detail to build or check against.',
        criteriaFalse: 'The document is a schedule, a discussion, a report of results, or a loose idea.',
    },
    {
        name: 'plan',
        instructions: 'What will be done, in what order, by whom or by when.',
        criteriaTrue: 'The document lays out future work: a roadmap, work breakdown, task list, milestones or schedule.',
        criteriaFalse: 'The document describes how something works, or what already happened.',
    },
    {
        name: 'test report',
        instructions: 'Results of tests, checks or evaluations that were run.',
        criteriaTrue: 'The document reports outcomes: tests passed or failed, measurements, benchmark or audit findings.',
        criteriaFalse: 'The document describes tests to write or a plan to test, without results.',
    },
    {
        name: 'meeting notes',
        instructions: 'A record of a conversation: who said what, what was decided, what is left open.',
        criteriaTrue: 'The document is minutes, notes, a transcript or a summary of a meeting or discussion.',
        criteriaFalse: 'The document is a standalone specification, plan or dataset.',
    },
    {
        name: 'data',
        instructions: 'Structured records meant to be processed rather than read as prose.',
        criteriaTrue: 'The document is mostly rows, records or values: a table, CSV, JSON data, logs, an export.',
        criteriaFalse: 'The document is mostly prose or source code.',
    },
    {
        name: 'code',
        instructions: 'Source code, scripts or configuration.',
        criteriaTrue: 'The document is mostly program code, a script, a query, or a configuration file.',
        criteriaFalse: 'The document talks about code in prose, or only has a short snippet inside other text.',
    },
    {
        name: 'reference',
        instructions: 'Background material to look things up in.',
        criteriaTrue: 'The document is documentation, a guide, a manual, a glossary, or an article kept for reference.',
        criteriaFalse: 'The document is a plan, a report of results, meeting notes, or raw data.',
    },
];

export function tagFromRow(row: any): TagDefinition {
    return {
        id: row.id.trim(),
        name: row.name,
        instructions: row.instructions,
        criteriaTrue: row.criteria_true ?? null,
        criteriaFalse: row.criteria_false ?? null,
        revision: row.revision,
        enabled: row.enabled,
    };
}

export async function listTags(db: Queryable, serverId: string, opts: { enabledOnly?: boolean } = {}): Promise<TagDefinition[]> {
    const res = await db.query(
        `SELECT * FROM file_tag_definitions WHERE server_id = $1 ${opts.enabledOnly ? 'AND enabled' : ''} ORDER BY lower(name)`,
        [serverId]
    );
    return res.rows.map(tagFromRow);
}

/** How many tags are shown on a file in a message. */
const MAX_TAGS_SHOWN = 5;

/**
 * Add what tagging knows to message attachments, in place: `tags` (names at or
 * above the server's tag threshold, strongest first), `tagging` (the job's state)
 * and `injectionWarning`. Attachments of files that were never queued are left
 * exactly as they were, so servers without tagging see no change.
 */
export async function addTaggingToAttachments(db: Queryable, attachments: { id: string; [key: string]: unknown }[]): Promise<void> {
    if (attachments.length === 0) return;
    const ids = attachments.map(a => a.id);
    const jobs = await db.query(
        `SELECT j.file_id, j.state, j.coverage, j.injection_probability,
                COALESCE(s.tag_threshold, 0.5) AS tag_threshold, COALESCE(s.screening_flag_threshold, 0.7) AS flag_threshold
         FROM file_tag_jobs j LEFT JOIN ai_decision_settings s ON s.server_id = j.server_id
         WHERE j.file_id = ANY($1)`,
        [ids]
    );
    if (jobs.rows.length === 0) return;
    const tags = await db.query(
        `SELECT ft.file_id, t.name, ft.probability
         FROM file_tags ft JOIN file_tag_definitions t ON t.id = ft.tag_id AND t.enabled
         WHERE ft.file_id = ANY($1)
         ORDER BY ft.probability DESC, lower(t.name)`,
        [ids]
    );
    const jobByFile = new Map<string, any>(jobs.rows.map((r: any) => [r.file_id.trim(), r]));
    for (const attachment of attachments) {
        const job = jobByFile.get(attachment.id);
        if (!job) continue;
        attachment.tagging = job.state;
        attachment.tags = tags.rows
            .filter((r: any) => r.file_id.trim() === attachment.id && Number(r.probability) >= Number(job.tag_threshold))
            .slice(0, MAX_TAGS_SHOWN)
            .map((r: any) => r.name);
        if (job.coverage === 'partial') attachment.partial = true;
        if (job.injection_probability !== null && Number(job.injection_probability) >= Number(job.flag_threshold)) {
            attachment.injectionWarning = true;
        }
    }
}

/**
 * Give a server the default tags once. Recorded on the server's decision settings,
 * so an admin who deletes them all does not get them back.
 */
export async function seedDefaultTags(db: Queryable, serverId: string): Promise<boolean> {
    await db.query('INSERT INTO ai_decision_settings (server_id) VALUES ($1) ON CONFLICT DO NOTHING', [serverId]);
    const claimed = await db.query(
        'UPDATE ai_decision_settings SET tags_seeded = true WHERE server_id = $1 AND NOT tags_seeded RETURNING server_id',
        [serverId]
    );
    if (claimed.rows.length === 0) return false;
    for (const tag of DEFAULT_TAGS) {
        await db.query(
            `INSERT INTO file_tag_definitions (id, server_id, name, instructions, criteria_true, criteria_false)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
            [generateUlid(), serverId, tag.name, tag.instructions, tag.criteriaTrue ?? null, tag.criteriaFalse ?? null]
        );
    }
    return true;
}
