import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { ServerOptions } from '@modelcontextprotocol/sdk/server/index.js';
import { z } from 'zod';
import {
    AgoraChannel, channelInstructions, PERMISSION_REQUEST_NOTIFICATION,
    type AuthMode, type ChannelApi, type Notification, type SocketLike,
} from './channel.js';

export interface ChannelOptions {
    /** `--channel-mode`: run as a Claude Code Channel. */
    channelMode: boolean;
    /** `--auth subscription|api_key` (AGORA_AUTH). Subscription (default): owner-only. */
    auth: AuthMode;
    /** Declare `claude/channel/permission` and relay permission prompts as approval cards. */
    permissionRelay: boolean;
    /** Open a socket in plain MCP mode too, for the "connected / listening" state in the UI. */
    presence: boolean;
}

export function parseChannelOptions(args: string[], env: Record<string, string | undefined>): ChannelOptions {
    const i = args.indexOf('--auth');
    const raw = i !== -1 ? args[i + 1] : env.AGORA_AUTH;
    if (raw !== undefined && raw !== 'subscription' && raw !== 'api_key') {
        throw new Error('--auth must be "subscription" or "api_key".');
    }
    return {
        channelMode: args.includes('--channel-mode') || env.AGORA_CHANNEL_MODE === '1',
        auth: raw ?? 'subscription',
        permissionRelay: !args.includes('--no-permission-relay'),
        presence: !args.includes('--no-presence') && env.AGORA_PRESENCE !== 'off',
    };
}

/**
 * Server options from the channels reference: `experimental['claude/channel']` is always `{}`
 * (presence registers the listener); `experimental['claude/channel/permission']` is `{}` only
 * when the channel authenticates who answers, which Agora does (owner-only cards).
 * `tools` is added by McpServer when the chat tools are registered (two-way channel).
 */
export function channelServerOptions(options: ChannelOptions): ServerOptions {
    return {
        capabilities: {
            experimental: {
                'claude/channel': {},
                ...(options.permissionRelay ? { 'claude/channel/permission': {} } : {}),
            },
        },
        instructions: channelInstructions(options.auth),
    };
}

/** The four string fields of `notifications/claude/channel/permission_request`. */
export const PermissionRequestSchema = z.object({
    method: z.literal(PERMISSION_REQUEST_NOTIFICATION),
    params: z.object({
        request_id: z.string(),
        tool_name: z.string(),
        description: z.string(),
        input_preview: z.string(),
    }),
});

export function startChannel(
    server: Server,
    socket: SocketLike,
    api: ChannelApi,
    options: ChannelOptions & { defaultChannel?: string },
): AgoraChannel {
    const log = (line: string) => process.stderr.write(`${line}\n`);
    const channel = new AgoraChannel({
        api,
        auth: options.auth,
        defaultChannel: options.defaultChannel,
        // Custom Claude Code methods; the SDK passes unknown notification methods through
        notify: (n: Notification) => server.notification(n as any),
        log,
    });
    if (options.permissionRelay) {
        server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
            await channel.onPermissionRequest(params).catch(e => log(`[agora channel] relay failed: ${e}`));
        });
    }
    channel.attach(socket);
    return channel;
}
