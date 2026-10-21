import Fastify from 'fastify';
import { channelProjectRoutes } from '../../src/routes/channel-projects';
import { claimProject, verificationNotice, verificationSchema, VERIFY_COMMAND_PATTERN, type Project } from '../../src/lib/channel-projects';

const project = (over: Partial<Project> = {}): Project => ({
    channelId: 'C', instructions: 'Use npm.', version: 3, files: [], verify: null, updatedAt: null, updatedBy: null, ...over,
});

describe('claimProject', () => {
    it('is null without instructions or files', () => {
        expect(claimProject(project({ instructions: '  ' }), null, true)).toBeNull();
        expect(claimProject(project({ instructions: '', files: [{ id: 'F', name: 'a', mime: 'text/plain', size: 1 }] }), 3, false)).not.toBeNull();
    });
    it('is changed for a fresh conversation or a version the session has not had', () => {
        expect(claimProject(project(), 3, false)!.changed).toBe(false);
        expect(claimProject(project(), 3, true)!.changed).toBe(true);
        expect(claimProject(project(), 2, false)!.changed).toBe(true);
        expect(claimProject(project(), null, false)!.changed).toBe(true);
    });
});

describe('verificationNotice', () => {
    it('reports a pass, with fix turns when there were any', () => {
        expect(verificationNotice('coder', { command: 'npm test', status: 'passed', attempts: 0 })).toBe('coder: verify `npm test` passed.');
        expect(verificationNotice('coder', { command: 'npm test', status: 'passed', attempts: 2 })).toBe('coder: verify `npm test` passed after 2 fix turns.');
    });
    it('explains a skip', () => {
        expect(verificationNotice('coder', { command: 'npm test', status: 'skipped', attempts: 0, reason: 'not_allowed' }))
            .toBe('coder: verify `npm test` did not run: it is not in this host\'s verify.commands list (agora-host config).');
    });
    it('reports a timeout and a failure without output', () => {
        expect(verificationNotice('coder', { command: 'npm test', status: 'failed', attempts: 0, reason: 'timeout', exitCode: null }))
            .toBe('coder: verify `npm test` failed (timed out) after 0 fix turns. Last output: none');
        expect(verificationNotice('coder', { command: 'npm test', status: 'failed', attempts: 1, reason: 'no_session', exitCode: 2 }))
            .toBe('coder: verify `npm test` failed (exit 2) after 1 fix turn (the CLI gave no session to resume for a fix). Last output: none');
    });
});

describe('VERIFY_COMMAND_PATTERN', () => {
    const re = new RegExp(VERIFY_COMMAND_PATTERN);
    it.each(['npm test', 'npm run verify -- --reporter=dot', 'cargo test --all', './scripts/check.sh', 'go test ./...', 'node scripts/check.cmd'])('allows %s', c => expect(re.test(c)).toBe(true));
    it.each(['npm.cmd test', 'check.BaT', './scripts/check.CMD', 'C:/tools/check.bat test', 'check.cmd.'])('refuses batch executable %s (#142)', c => expect(re.test(c)).toBe(false));
    it.each(['npm test; rm -rf /', 'npm test && x', 'echo $HOME', 'a | b', '"quoted"', 'two  spaces', ' leading', 'a\nb', 'x > out'])('refuses %s', c => expect(re.test(c)).toBe(false));
});

describe('batch verify commands (#142)', () => {
    it('rejects batch commands on the real settings route before accessing the database', async () => {
        const app = Fastify();
        const query = vi.fn();
        app.addHook('onRequest', async request => { request.dbClient = { query } as any; });
        await app.register(channelProjectRoutes);
        try {
            for (const command of ['npm.cmd test', 'check.BaT', './scripts/check.CMD', 'C:/tools/check.bat test', 'check.cmd.']) {
                const response = await app.inject({ method: 'PUT', url: '/channels/test/project/verify', payload: { command } });
                expect(response.statusCode).toBe(400);
            }
            expect(query).not.toHaveBeenCalled();
        } finally { await app.close(); }
    });

    it('accepts a skipped report for a previously saved batch command so the run can finish', async () => {
        const app = Fastify();
        app.post('/report', { schema: { body: verificationSchema } }, async request => request.body);
        try {
            const response = await app.inject({ method: 'POST', url: '/report', payload: {
                command: './scripts/check.cmd', status: 'skipped', attempts: 0, reason: 'not_allowed',
            } });
            expect(response.statusCode).toBe(200);
        } finally { await app.close(); }
    });
});
