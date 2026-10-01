import fs from 'node:fs';
import path from 'node:path';
import { typesafeAdapter } from '../../src/ai/adapters/typesafe';
import { validateDecideResult } from '../../src/ai/decide-validate';
import { injectionQuestion, intentQuestion, type AssistantIntent } from '../../src/ai/decision-questions';
import type { DecideQuestion } from '../../src/ai/adapters';

/**
 * Live contract check against TypeSafe. Opt-in: it costs a few thousand tokens.
 *
 *     JEV_LIVE=1 JEV_KEY=... npx vitest run test/live
 *
 * Run it after any change to the adapter or to a question's wording. It asserts
 * the response contract and verdict classes for the golden inputs, never exact
 * probabilities (those move between model versions).
 */

const live = !!process.env.JEV_LIVE && !!process.env.JEV_KEY;
const creds = { apiKey: process.env.JEV_KEY };
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'decisions', name), 'utf8'));

const FLAG = 0.7;
const SUSPECT = 0.35;

describe.skipIf(!live)('TypeSafe live contract', () => {
    test('all three question types come back in the shape the adapter maps', async () => {
        const questions: Record<string, DecideQuestion> = {
            n: { type: 'noul', instructions: 'Is `doc` about plants?' },
            c: { type: 'choice', instructions: 'What is `doc` about?', criteria: { plants: 'Plants or gardening', software: 'Software', other: 'Anything else' } },
            s: { type: 'score', instructions: 'How detailed is `doc`?', criteria: ['One line', 'A paragraph', 'Several paragraphs'] },
        };
        const raw = await typesafeAdapter.decide!(creds, { model: 'jev-latest', state: { doc: 'Water the fern weekly.' }, questions, timeoutMs: 15_000 });
        const result = validateDecideResult(questions, raw);
        expect(result.model).toMatch(/^jev-/);
        expect(result.usage.inputTokens).toBeGreaterThan(0);
        expect(result.answers.c).toMatchObject({ type: 'choice', choice: 'plants' });
        expect((result.answers.n as any).probability).toBeGreaterThan(0.5);
    });

    test('a bad key is a 401 the adapter reports without echoing the key', async () => {
        const err = await typesafeAdapter.decide!({ apiKey: 'not-a-real-key' }, { model: 'jev-latest', state: 'x', questions: { q: { type: 'noul', instructions: 'ok?' } } }).catch(e => e);
        expect(err.kind).toBe('permanent');
        expect(err.status).toBe(401);
        expect(err.message).not.toContain('not-a-real-key');
    });

    test('testConnection succeeds', async () => {
        expect(await typesafeAdapter.testConnection(creds, 'jev-latest')).toEqual({ ok: true });
    });

    test('intent question: golden requests reach the right handler, and one that is not offered is never chosen', async () => {
        const { cases, handlers } = fixture('routing.json') as { handlers: AssistantIntent[]; cases: { id: string; expect?: string; either?: string[]; text: string }[] };
        const ask = async (text: string, offered: AssistantIntent[]) => {
            const questions = { intent: intentQuestion(offered) };
            const result = validateDecideResult(questions, await typesafeAdapter.decide!(creds, { model: 'jev-latest', state: { request: text }, questions, timeoutMs: 15_000 }));
            return result.answers.intent as { choice: string; confidence: number };
        };

        const wrong: string[] = [];
        for (const c of cases) {
            const answer = await ask(c.text, handlers);
            const accepted = c.expect ? [c.expect] : c.either!;
            if (!accepted.includes(answer.choice)) wrong.push(`${c.id}: ${answer.choice} (expected ${accepted.join(' or ')})`);
        }
        expect(wrong).toEqual([]);

        const narrowed = await ask('search the web for the latest gVisor release', ['chat', 'audio_overview']);
        expect(['chat', 'audio_overview']).toContain(narrowed.choice);
    }, 60_000);

    test('injection question: golden inputs land in their verdict class, batched in one call', async () => {
        const { cases } = fixture('injection.json') as { cases: { id: string; expect: string; text: string }[] };
        const items: Record<string, string> = {};
        const questions: Record<string, DecideQuestion> = {};
        for (const c of cases) {
            items[c.id] = c.text;
            questions[c.id] = injectionQuestion(`items.${c.id}`);
        }
        const result = validateDecideResult(questions, await typesafeAdapter.decide!(creds, { model: 'jev-latest', state: { items }, questions, timeoutMs: 20_000 }));

        const wrong: string[] = [];
        for (const c of cases) {
            const p = (result.answers[c.id] as { probability: number }).probability;
            if (c.expect === 'clean' && p >= SUSPECT) wrong.push(`${c.id}: ${p} (expected clean)`);
            if (c.expect === 'flagged' && p < FLAG) wrong.push(`${c.id}: ${p} (expected flagged)`);
        }
        expect(wrong).toEqual([]);
    });
});
