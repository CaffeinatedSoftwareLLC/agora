import { claimSummary, gradeClaim, recogniseGate, roundOutcome, voteReason } from '../../src/lib/receipts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const FILE = '01JD8Z6Q4X7N3K5M9R2T8V6W4Y';
const OTHER = '01JD8Z6Q4X7N3K5M9R2T8V6W4Z';

describe('gradeClaim', () => {
    it('a bare claim is unverified', () => {
        expect(gradeClaim('fix', null)).toEqual({ grade: 'unverified', reason: 'no_run', basis: 'assumed' });
    });

    it('waits for a run that is still going', () => {
        expect(gradeClaim('fix', { status: 'claimed' })).toEqual({ grade: 'unverified', reason: 'run_in_progress', basis: 'assumed' });
    });

    it('a finished run with a commit and a passed verify command is verified and tested', () => {
        expect(gradeClaim('fix', { status: 'succeeded', baseSha: A, headSha: B, changedPaths: ['src/a.ts'], verification: { status: 'passed' } }))
            .toEqual({ grade: 'verified', reason: 'tests_passed', basis: 'tested' });
    });

    it('a commit without a passed verify command is verified but assumed', () => {
        for (const verification of [undefined, null, { status: 'skipped' }]) {
            expect(gradeClaim('fix', { status: 'succeeded', baseSha: A, headSha: B, verification }))
                .toEqual({ grade: 'verified', reason: 'committed', basis: 'assumed' });
        }
    });

    it('grades a run with a commit above a bare claim', () => {
        const rank = { contradicted: 0, unverified: 1, verified: 2 };
        const withRun = gradeClaim('plan', { status: 'succeeded', baseSha: A, headSha: B });
        expect(rank[withRun.grade]).toBeGreaterThan(rank[gradeClaim('plan', null).grade]);
    });

    it('a failed verify command contradicts the claim, whatever the run status', () => {
        for (const status of ['succeeded', 'failed']) {
            expect(gradeClaim('fix', { status, baseSha: A, headSha: B, verification: { status: 'failed' } }))
                .toEqual({ grade: 'contradicted', reason: 'verification_failed', basis: 'tested' });
        }
    });

    it('a failed run contradicts the claim, unless it was stopped from outside', () => {
        expect(gradeClaim('fix', { status: 'failed', error: 'cli_failed_or_invalid_output' })).toMatchObject({ grade: 'contradicted', reason: 'run_failed' });
        expect(gradeClaim('fix', { status: 'failed', error: 'rate_limited' })).toMatchObject({ grade: 'unverified', reason: 'run_interrupted' });
        expect(gradeClaim('fix', { status: 'failed', error: 'boom', cancelRequested: true })).toMatchObject({ grade: 'unverified', reason: 'run_interrupted' });
        expect(gradeClaim('fix', { status: 'expired' })).toMatchObject({ grade: 'unverified', reason: 'run_interrupted' });
    });

    it('a fix that changed nothing is contradicted; other modes without a commit are unverified', () => {
        expect(gradeClaim('fix', { status: 'succeeded', changedPaths: [] })).toMatchObject({ grade: 'contradicted', reason: 'no_changes' });
        expect(gradeClaim('fix', { status: 'succeeded', baseSha: A, headSha: A, changedPaths: [] })).toMatchObject({ grade: 'contradicted', reason: 'no_changes' });
        expect(gradeClaim('fix', { status: 'succeeded', baseSha: A, headSha: A, changedPaths: ['x'] })).toMatchObject({ grade: 'unverified', reason: 'not_committed' });
        expect(gradeClaim('plan', { status: 'succeeded' })).toMatchObject({ grade: 'unverified', reason: 'no_commit' });
        expect(gradeClaim('review', { status: 'succeeded', verification: { status: 'passed' } })).toMatchObject({ grade: 'unverified', reason: 'no_commit' });
    });

    it('has no input for self-reported evidence', () => {
        // The signature is the guarantee: a run's facts and the mode, nothing the author attached
        expect(gradeClaim.length).toBe(2);
        const facts = { status: 'succeeded', selfReported: [{ sha: B, tested: true }] } as any;
        expect(gradeClaim('fix', facts)).toMatchObject({ grade: 'contradicted', reason: 'no_changes' });
    });
});

describe('recogniseGate', () => {
    it('takes each of the five words with a quoted file ID', () => {
        for (const word of ['approved', 'agreed', 'accepted', 'confirmed']) {
            expect(recogniseGate(`${word} ${FILE}`)).toEqual({ word, fileId: FILE, reason: null });
        }
        expect(recogniseGate(`rejected: cap is too high ${FILE}`)).toEqual({ word: 'rejected', fileId: FILE, reason: 'cap is too high' });
    });

    it('accepts the usual ways of quoting the ID', () => {
        const forms = [`Approved ${FILE}`, `${FILE} approved`, `approved file ${FILE}`, `approved (file ID: ${FILE})`, `approved \`${FILE}\`.`,
            `approved: ${FILE}`, `APPROVED\n/files/${FILE}`, `approved file=${FILE}!`];
        for (const text of forms) expect(recogniseGate(text), text).toEqual({ word: 'approved', fileId: FILE, reason: null });
        expect(recogniseGate(`file ${FILE} rejected: no tests\nrun them first`)).toEqual({ word: 'rejected', fileId: FILE, reason: 'no tests run them first' });
    });

    it('needs exactly one file ID', () => {
        expect(recogniseGate('approved')).toBeNull();
        expect(recogniseGate(`approved ${FILE} ${OTHER}`)).toBeNull();
        expect(recogniseGate(`approved ${FILE} ${FILE}`)).toEqual({ word: 'approved', fileId: FILE, reason: null });
        // Not a ULID: lower case, or part of a longer token
        expect(recogniseGate(`approved ${FILE.toLowerCase()}`)).toBeNull();
        expect(recogniseGate(`approved X${FILE}`)).toBeNull();
    });

    it('refuses anything looser than the exact word', () => {
        const loose = [`approved, but lower the cap ${FILE}`, `looks good ${FILE}`, `I approved ${FILE}`, `not approved ${FILE}`, `approve ${FILE}`,
            `rejected ${FILE}`, `rejected: ${FILE}`, `accepted with exceptions: tests ${FILE}`, `approved ${FILE} and agreed`, `ok ${FILE}`];
        for (const text of loose) expect(recogniseGate(text), text).toBeNull();
        expect(recogniseGate(null)).toBeNull();
        expect(recogniseGate('   ')).toBeNull();
        expect(recogniseGate(`approved ${FILE} ${'x'.repeat(800)}`)).toBeNull();
    });
});

describe('roundOutcome', () => {
    const v = (voterId: string, vote: 'agree' | 'block') => ({ voterId, vote });

    it('stays open until every named participant has voted', () => {
        expect(roundOutcome([v('a', 'agree')], ['a', 'b'], null)).toBe('open');
        expect(roundOutcome([v('a', 'block')], ['a', 'b'], null)).toBe('open');
        expect(roundOutcome([v('a', 'agree'), v('b', 'agree')], ['a', 'b'], null)).toBe('agreed');
        expect(roundOutcome([v('a', 'agree'), v('b', 'block')], ['a', 'b'], null)).toBe('blocked');
    });

    it('never closes on its own when the thread names nobody', () => {
        expect(roundOutcome([v('a', 'agree'), v('b', 'agree')], [], null)).toBe('open');
    });

    it('closes on the votes cast when the thread ends', () => {
        expect(roundOutcome([v('a', 'agree')], ['a', 'b'], 'done')).toBe('abandoned');
        expect(roundOutcome([v('a', 'block')], ['a', 'b'], 'done')).toBe('blocked');
        expect(roundOutcome([v('a', 'agree')], ['a', 'b'], 'blocked')).toBe('blocked');
        expect(roundOutcome([v('a', 'agree')], ['a', 'b'], 'cancelled')).toBe('abandoned');
        expect(roundOutcome([v('a', 'agree'), v('b', 'agree')], [], 'done')).toBe('agreed');
        expect(roundOutcome([v('a', 'agree')], [], 'done')).toBe('abandoned');
    });
});

describe('claimSummary and voteReason', () => {
    it('keeps the post\'s own text without the header and the closing YIELD', () => {
        expect(claimSummary('[AGORA/v1 MODE=fix STATE=DONE]\nFixed the upload race.\n\nTests pass.\n[YIELD to=codex]')).toBe('Fixed the upload race.\nTests pass.');
        expect(claimSummary('[AGORA/v1 MODE=fix STATE=DONE] Fixed it')).toBe('Fixed it');
        expect(claimSummary('[AGORA/v1 MODE=fix STATE=DONE]')).toBeNull();
        expect(claimSummary(`[AGORA/v1 MODE=fix STATE=DONE]\n${'x'.repeat(900)}`)).toHaveLength(500);
    });

    it('takes the reason after AGREE or BLOCK', () => {
        expect(voteReason('[AGORA/v1 MODE=plan STATE=DECIDE]\nBLOCK must keep RLS')).toBe('must keep RLS');
        expect(voteReason('[AGORA/v1 MODE=plan STATE=DECIDE] BLOCK: no tests')).toBe('no tests');
        expect(voteReason('[AGORA/v1 MODE=plan STATE=DECIDE]\nAGREE')).toBeNull();
    });
});
