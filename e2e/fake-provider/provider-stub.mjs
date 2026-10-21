/**
 * A stand-in OpenAI-compatible endpoint for OP-03.provider-down, OP-03.ws-loss and OP-06
 * (beta-test-plan §3.5). It runs in a throwaway agora-e2e-* container on the e2e network
 * (lib/containers.ts startStub), so the API reaches it by container name. The provider's base
 * URL picks the behaviour: http://<stub>:8080/<mode>/<tag>/v1, and the adapter appends
 * /chat/completions.
 *
 *   ok      stream "<tag>-ok" with usage (7 prompt + 3 completion tokens)
 *   slow    stream 40 words "<tag>-w01" ... "<tag>-w40", one every STUB_SLOW_MS (default 300 ms)
 *   r429    answer 429 with an OpenAI-style error body and Retry-After: 1
 *   hang    read the request and never answer
 *   r401    answer 401 with an OpenAI-style "Incorrect API key" body (a server refusing the key)
 *   speech  a speech-only server (Kokoro-FastAPI, speaches): POST /audio/speech answers a short
 *           silent WAV, POST /audio/transcriptions answers { text: "<tag> heard you" }, and
 *           /chat/completions is a 404, as on those servers
 *   other   (e.g. nf) 404 with no body: a wrong endpoint
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

/** 16-bit mono PCM WAV of silence at 24 kHz (what Kokoro answers for response_format=wav). */
function silentWav(seconds) {
    const rate = 24000, n = Math.round(rate * seconds), b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8, 'latin1');
    b.write('fmt ', 12, 'latin1'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
    b.write('data', 36, 'latin1'); b.writeUInt32LE(n * 2, 40);
    return b;
}

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
        const url = req.url ?? '';
        if (req.method === 'POST' && mode === 'r401') {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Incorrect API key provided (stub)', type: 'invalid_request_error' } }));
            return;
        }
        if (req.method === 'POST' && mode === 'speech' && url.endsWith('/audio/speech')) {
            res.writeHead(200, { 'content-type': 'audio/wav' });
            res.end(silentWav(0.2));
            return;
        }
        if (req.method === 'POST' && mode === 'speech' && url.endsWith('/audio/transcriptions')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ text: `${tag} heard you` }));
            return;
        }
        if (req.method !== 'POST' || !url.endsWith('/chat/completions') || mode === 'speech') { res.writeHead(404).end(); return; }
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
