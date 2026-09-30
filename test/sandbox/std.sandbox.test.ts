import { createHash } from 'node:crypto';
import { setupTestApp, authedUser, createServer, cleanDatabase } from '../helpers';
import { generateUlid } from '../../src/utils/ulid';
import { dockerFromEnv, SandboxDocker } from '../../src/runtime/docker';
import { processRun, type RunnerDeps } from '../../src/runtime/runner';
import { resolveLimits } from '../../src/runtime/limits';
import { startGatewayHarness, type RecordedRequest } from './gateway-harness';

/** WBS 3.3: agora:std inside a real sandbox, talking to a fake gateway. */

const IMAGE = process.env.AGORA_SANDBOX_IMAGE ?? 'agora/sandbox-deno:dev';
const NETWORK = process.env.AGORA_SANDBOX_NETWORK ?? 'agora_sandbox';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;
let serverId: string;
let deps: RunnerDeps;
let gateway: Awaited<ReturnType<typeof startGatewayHarness>>;

function respond(req: RecordedRequest): { status: number; body: unknown } {
    if (req.path === '/v1/capabilities/search') return { status: 200, body: { answer: '42', citations: [{ url: 'https://example.com/a', title: 'A' }] } };
    if (req.path === '/v1/capabilities/image') return { status: 429, body: { error: 'Capability call limit reached', code: 'call_limit' } };
    if (req.path === '/v1/files') return { status: 201, body: { id: 'file1', url: '/files/file1' } };
    if (req.path === '/v1/messages') return { status: 201, body: { id: 'msg1' } };
    return { status: 404, body: { error: 'not found', code: 'not_found' } };
}

async function run(code: string) {
    const id = generateUlid();
    await ctx.db.query(
        `INSERT INTO exec_runs (id, server_id, code, code_sha256, limits, gate_decision, status, requested_capabilities)
         VALUES ($1, $2, $3, $4, $5, 'auto_run', 'queued', $6)`,
        [id, serverId, code, createHash('sha256').update(code).digest('hex'), JSON.stringify(resolveLimits('standard')), ['search', 'image']]
    );
    const result = await processRun(deps, id);
    const row = (await ctx.db.query('SELECT * FROM exec_runs WHERE id = $1', [id])).rows[0];
    return { id, result, row };
}

beforeAll(async () => {
    ctx = await setupTestApp();
    await cleanDatabase(ctx.db);
    const owner = await authedUser(ctx.request, 'stdowner');
    ({ serverId } = await createServer(ctx.request, owner.auth, 'Std Server'));

    const sandbox = new SandboxDocker(dockerFromEnv(process.env.AGORA_DOCKER_HOST ?? 'http://127.0.0.1:2375'));
    const { runtime } = await sandbox.preflight({ image: IMAGE, network: NETWORK, requireGvisor: false });
    deps = {
        db: ctx.db,
        sandbox,
        config: { image: IMAGE, network: NETWORK, runtime, capUrl: 'http://cap-gateway:8080', perServerConcurrency: 4, capacityRetryMs: 100 },
    };
    gateway = await startGatewayHarness(NETWORK, respond);
});

afterAll(async () => {
    await gateway?.stop();
    await ctx.close();
});

beforeEach(() => {
    gateway.requests.length = 0;
});

describe('agora:std', () => {
    test('search via import, authenticated with this run\'s token', async () => {
        const { id, result, row } = await run(`
            import { search } from "agora:std";
            const res = await search("meaning of life", { maxResults: 3 });
            console.log(JSON.stringify(res));
        `);
        expect(result).toEqual({ kind: 'ran', status: 'succeeded' });
        expect(JSON.parse(row.stdout_tail.trim())).toEqual({ answer: '42', citations: [{ url: 'https://example.com/a', title: 'A' }] });

        const req = gateway.requests.find(r => r.path === '/v1/capabilities/search')!;
        expect(req.method).toBe('POST');
        expect(JSON.parse(req.body.toString())).toEqual({ query: 'meaning of life', maxResults: 3 });

        // The bearer token matches the hash the runner stored for this run
        const token = String(req.headers.authorization).replace(/^Bearer /, '');
        const stored = await ctx.db.query('SELECT token_hash FROM exec_run_tokens WHERE run_id = $1', [id]);
        expect(createHash('sha256').update(token).digest('hex')).toBe(stored.rows[0].token_hash);
    });

    test('global agora object works without an import', async () => {
        const { result, row } = await run(`
            const res = await agora.search("no import needed");
            console.log(res.answer);
        `);
        expect(result).toEqual({ kind: 'ran', status: 'succeeded' });
        expect(row.stdout_tail.trim()).toBe('42');
    });

    test('gateway errors surface as AgoraError with status and code', async () => {
        const { result, row } = await run(`
            import { generateImage, AgoraError } from "agora:std";
            try { await generateImage("a cat"); }
            catch (e) { console.log(e instanceof AgoraError, e.status, e.code, e.message); }
        `);
        expect(result).toEqual({ kind: 'ran', status: 'succeeded' });
        expect(row.stdout_tail.trim()).toBe('true 429 call_limit Capability call limit reached');
    });

    test('postFile sends raw bytes with filename, type, and message', async () => {
        const { result, row } = await run(`
            import { postFile } from "agora:std";
            const out = await postFile("report ✓.html", "<h1>ok</h1>", { message: "Results are in" });
            console.log(out.id);
        `);
        expect(result).toEqual({ kind: 'ran', status: 'succeeded' });
        expect(row.stdout_tail.trim()).toBe('file1');

        const req = gateway.requests.find(r => r.path === '/v1/files')!;
        expect(req.body.toString()).toBe('<h1>ok</h1>');
        expect(req.headers['content-type']).toBe('text/html');
        expect(decodeURIComponent(String(req.headers['x-agora-filename']))).toBe('report ✓.html');
        expect(decodeURIComponent(String(req.headers['x-agora-message']))).toBe('Results are in');
    });

    test('postMessage posts text to the thread', async () => {
        const { result } = await run(`import { postMessage } from "agora:std"; await postMessage("done");`);
        expect(result).toEqual({ kind: 'ran', status: 'succeeded' });
        const req = gateway.requests.find(r => r.path === '/v1/messages')!;
        expect(JSON.parse(req.body.toString())).toEqual({ content: 'done' });
    });

    test('capability names are validated client-side (no path tricks)', async () => {
        const { row } = await run(`
            import { call } from "agora:std";
            try { await call("../admin", {}); } catch (e) { console.log(e.code); }
        `);
        expect(row.stdout_tail.trim()).toBe('invalid_capability');
        expect(gateway.requests).toHaveLength(0);
    });

    test('still no other network access alongside the gateway', async () => {
        const { row } = await run(`
            try { await fetch("https://example.com"); console.log("REACHED"); } catch (e) { console.log(e.name); }
        `);
        expect(row.stdout_tail.trim()).toBe('NotCapable');
    });
});
