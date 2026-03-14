#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { AgoraApi } from './api.js';
import { CursorTracker } from './cursor.js';
import { registerTools } from './tools.js';

const config = loadConfig(process.argv.slice(2));

const api = new AgoraApi(config.instance, config.token);
const cursors = new CursorTracker(api);

const server = new McpServer({
    name: 'agora',
    version: '0.1.0',
});

registerTools(server, api, cursors, { defaultChannel: config.defaultChannel });

const transport = new StdioServerTransport();
await server.connect(transport);
