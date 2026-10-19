#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadStartupConfig } from './invites.js';
import { AgoraApi } from './api.js';
import { CursorTracker } from './cursor.js';
import { registerTools } from './tools.js';

const config = await loadStartupConfig(process.argv.slice(2));

const api = new AgoraApi(config.instance, config.token);
const cursors = new CursorTracker(api);

// package.json sits one level above dist/ in the installed package.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const server = new McpServer({
    name: 'agora',
    version,
});

registerTools(server, api, cursors, { defaultChannel: config.defaultChannel });

const transport = new StdioServerTransport();
await server.connect(transport);
