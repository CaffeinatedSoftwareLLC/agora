#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadStartupConfig } from './invites.js';
import { AgoraApi } from './api.js';
import { CursorTracker } from './cursor.js';
import { registerResources, registerTools } from './tools.js';
import { ActivityReporter, connectSocket, ListeningReporter } from './socket.js';
import { channelServerOptions, parseChannelOptions, startChannel } from './channel-server.js';

// package.json sits one level above dist/ in the installed package.
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const args = process.argv.slice(2);
if (args.includes('--version')) {
    console.log(version);
    process.exit(0);
}

const options = parseChannelOptions(args, process.env);
const config = await loadStartupConfig(args);

const api = new AgoraApi(config.instance, config.token);
const cursors = new CursorTracker(api);

// Channel mode (docs/claude-channel.md): declare the claude/channel capability so Claude Code
// registers a listener for pushed messages. Claude Code delivers `instructions` to Claude.
const server = options.channelMode
    ? new McpServer({ name: 'agora', version }, channelServerOptions(options))
    : new McpServer({ name: 'agora', version });

const listening = !options.channelMode && options.presence ? new ListeningReporter() : undefined;
// Terminal session (#112): with presence (or as a channel), Agora tracks this agent as a
// terminal session; tool calls report working/idle to it. Hosted runs pass --no-presence.
const activity = options.channelMode || options.presence ? new ActivityReporter() : undefined;
registerTools(server, api, cursors, { defaultChannel: config.defaultChannel, listening, activity });
registerResources(server, api);

const transport = new StdioServerTransport();
await server.connect(transport);

// Opened after stdio is up, so no pushed message is sent before Claude Code is listening.
// The socket reports "connected / listening" to Agora, and in channel mode carries the messages.
if (options.channelMode) {
    const socket = connectSocket(config.instance, config.token, 'channel');
    startChannel(server.server, socket, api, { ...options, defaultChannel: config.defaultChannel });
    activity?.attach(socket);
} else if (listening) {
    const socket = connectSocket(config.instance, config.token, 'mcp');
    listening.attach(socket);
    activity?.attach(socket);
}

// The socket's reconnect timers would keep the process alive after Claude Code (or any
// client) goes away; stdin closing means the session is over.
if (options.channelMode || listening) {
    const exit = () => process.exit(0);
    process.stdin.once('end', exit);
    process.stdin.once('close', exit);
}
