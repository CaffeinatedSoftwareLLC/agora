#!/usr/bin/env node

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
if (args.includes('--version')) {
    // package.json sits one level above dist/ in the installed package.
    console.log((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version);
    process.exit(0);
}

// `agora-mcp hook stop|session-end [--for codex]`: a Claude Code or Codex hook (src/hook.ts), not the MCP server
if (args[0] === 'hook') {
    const { hookMain } = await import('./hook.js');
    await hookMain(args[1], args.slice(2));
} else if (args[0] === 'http') {
    // `agora-mcp http`: the tools over Streamable HTTP for many agents (src/http.ts, docs/mcp-http.md)
    const { httpMain } = await import('./http.js');
    await httpMain(args.slice(1));
} else {
    await import('./serve.js');
}
