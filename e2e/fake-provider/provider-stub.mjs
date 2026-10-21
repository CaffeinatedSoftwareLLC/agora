/**
 * A stand-in OpenAI-compatible chat endpoint for OP-03.provider-down and OP-03.ws-loss
 * (beta-test-plan §3.5). It runs in a throwaway agora-e2e-* container on the e2e network
 * (lib/containers.ts startStub), so the API reaches it by container name. The provider's base
 * URL picks the behaviour: http://<stub>:8080/<mode>/<tag>/v1, and the adapter appends
 * /chat/completions.
 *
 *   ok      stream "<tag>-ok" with usage (7 prompt + 3 completion tokens)
 *   slow    stream 40 words "<tag>-w01" ... "<tag>-w40", one every STUB_SLOW_MS (default 300 ms)
 *   r429    answer 429 with an OpenAI-style error body and Retry-After: 1
 *   hang    read the request and never answer
 *
 * Each request prints one line "HIT <mode> <tag>" to stdout; the tests count them with
 * `docker logs`. No keys, no outbound traffic.
 */
import http from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 8080);
const SLOW_MS = Number(process.env.STUB_SLOW_MS ?? 300);
const held = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const chunk = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

async function stream(res, words, everyMs) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const [i, w] of words.entries()) {
        if (i > 0 && everyMs) await sleep(everyMs);
        chunk(res, { choices: [{ index: 0, delta: { content: i === 0 ? w : ` ${w}` } }] });
    }
    chunk(res, { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } });
    res.end('data: [DONE]\n\n');
}

http.createServer((req, res) => {
    const [, mode = '', tag = 'none'] = (req.url ?? '').split('/');
    console.log(`HIT ${mode} ${tag}`);
    req.resume();
    req.on('end', () => {
        if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) { res.writeHead(404).end(); return; }
        if (mode === 'ok') return void stream(res, [`${tag}-ok`], 0);
        if (mode === 'slow') return void stream(res, Array.from({ length: 40 }, (_, i) => `${tag}-w${String(i + 1).padStart(2, '0')}`), SLOW_MS);
        if (mode === 'r429') {
            res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
            res.end(JSON.stringify({ error: { message: 'Rate limit reached (stub)', type: 'rate_limit_error' } }));
            return;
        }
        if (mode === 'hang') { held.add(res); res.on('close', () => held.delete(res)); return; }
        res.writeHead(404).end();
    });
}).listen(PORT, '0.0.0.0', () => console.log(`READY ${PORT}`));
