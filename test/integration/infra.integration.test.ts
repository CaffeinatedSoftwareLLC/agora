import { setupTestApp } from '../helpers';

let ctx: Awaited<ReturnType<typeof setupTestApp>>;

beforeAll(async () => { ctx = await setupTestApp(); });
afterAll(async () => { await ctx.close(); });

describe('Infrastructure', () => {
    test('API health ok and migrations ran', async () => {
        const res = await ctx.request.get('/health');
        expect(res.status).toBe(200);

        // Proves migrations ran — doesn't depend on runner internals
        await ctx.db.query('SELECT 1 FROM users LIMIT 0');
    });
});
