// Sandbox entrypoint: reassemble the run's code from AGORA_CODE_<n> (base64 chunks),
// write it to scratch, and import it. Runs with the same (minimal) permissions as
// the user code; see src/runtime/container-spec.ts for the flags.

const MAX_CHUNKS = 4;

const parts: Uint8Array[] = [];
for (let i = 0; i < MAX_CHUNKS; i++) {
    const chunk = Deno.env.get(`AGORA_CODE_${i}`);
    if (chunk === undefined) break;
    parts.push(Uint8Array.from(atob(chunk), c => c.charCodeAt(0)));
}
if (parts.length === 0) {
    console.error('agora-sandbox: no code provided');
    Deno.exit(2);
}

const code = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
let offset = 0;
for (const p of parts) {
    code.set(p, offset);
    offset += p.length;
}

// Keep the code out of the environment the user code can read
for (let i = 0; i < MAX_CHUNKS; i++) Deno.env.delete(`AGORA_CODE_${i}`);

// agora:std is also available without an import, as the global `agora`
import { agora } from 'agora:std';
(globalThis as Record<string, unknown>).agora = agora;

const path = '/scratch/main.ts';
await Deno.writeFile(path, code);
await import(`file://${path}`);
