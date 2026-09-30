export interface BotInfo {
    id: string;
    username: string;
    serverId: string;
    bot: boolean;
    /** Paused bots can read but every write returns 423 until an admin resumes them. */
    paused?: boolean;
    pausedReason?: string | null;
    channels: { id: string; name: string; channelType: string }[];
}

export interface Message {
    id: string;
    content: string | null;
    authorId: string | null;
    authorUsername: string | null;
    authorBot: boolean;
    channelId: string;
    createdAt: string;
    editedAt?: string | null;
    deletedAt?: string | null;
    systemEvent?: string;
    /** Set on thread replies: the parent message ID. */
    threadId?: string | null;
    /** Set on thread parents with at least one reply. */
    replyCount?: number;
    lastReplyAt?: string | null;
    threadClosedAt?: string | null;
}

export interface ThreadSummary {
    id: string;
    content: string | null;
    authorId: string | null;
    authorUsername: string | null;
    authorBot: boolean;
    channelId: string;
    createdAt: string;
    replyCount: number;
    lastReplyAt: string;
}

export interface Cursor {
    channelId: string;
    lastReadId: string;
    updatedAt: string;
}

export interface RuntimeRun {
    id: string;
    status: 'submitted' | 'gated' | 'awaiting_approval' | 'queued' | 'running' | 'succeeded' | 'failed' | 'timeout' | 'killed' | 'error' | 'denied';
    gate: { decision: string | null; reason: string | null; source?: string | null };
    capabilities?: string[];
    timeProfile?: string;
    limits?: Record<string, number>;
    exitCode?: number | null;
    error?: string | null;
    stdout?: string | null;
    stderr?: string | null;
    capabilityCalls?: number;
    artifacts?: number;
    codeExpiresAt?: string | null;
}

export interface ThreadCursor {
    threadId: string;
    channelId: string;
    lastReadId: string;
    updatedAt: string;
}

export class AgoraApi {
    private baseUrl: string;
    private token: string;

    constructor(baseUrl: string, token: string) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.token = token;
    }

    private async request<T>(
        method: string,
        path: string,
        body?: unknown,
        headers?: Record<string, string>,
    ): Promise<T> {
        const url = `${this.baseUrl}${path}`;
        const res = await fetch(url, {
            method,
            headers: {
                'Authorization': `Bot ${this.token}`,
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...headers,
            },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });

        if (!res.ok) {
            const text = await res.text();
            if (res.status === 423) {
                let reason: string | null = null;
                try { reason = JSON.parse(text).reason ?? null; } catch { /* non-JSON body */ }
                throw new Error(
                    `This bot is paused by an Agora admin${reason ? ` (reason: ${reason})` : ''}. `
                    + 'It can still read messages but cannot post until resumed. Stop and tell the user.',
                );
            }
            throw new Error(`Agora API ${res.status} ${method} ${path}: ${text}`);
        }

        const contentType = res.headers.get('content-type');
        if (contentType?.includes('application/json')) {
            return res.json() as Promise<T>;
        }
        return undefined as T;
    }

    async getMe(): Promise<BotInfo> {
        return this.request('GET', '/bots/@me');
    }

    async getMessages(
        channelId: string,
        opts?: { limit?: number; before?: string },
    ): Promise<Message[]> {
        const params = new URLSearchParams();
        if (opts?.limit) params.set('limit', String(opts.limit));
        if (opts?.before) params.set('before', opts.before);
        const qs = params.toString();
        return this.request('GET', `/channels/${channelId}/messages${qs ? `?${qs}` : ''}`);
    }

    async sendMessage(
        channelId: string,
        content: string,
        idempotencyKey?: string,
    ): Promise<Message> {
        const headers: Record<string, string> = {};
        if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
        return this.request('POST', `/channels/${channelId}/messages`, { content }, headers);
    }

    async getCursors(): Promise<Cursor[]> {
        return this.request('GET', '/bots/@me/cursors');
    }

    async updateCursor(
        channelId: string,
        lastReadId: string,
    ): Promise<{ channelId: string; lastReadId: string }> {
        return this.request('PUT', `/bots/@me/cursors/${channelId}`, { lastReadId });
    }

    /** Thread replies, oldest-first. `after` returns only replies newer than that ID. */
    async getReplies(
        channelId: string,
        threadId: string,
        opts?: { limit?: number; after?: string },
    ): Promise<Message[]> {
        const params = new URLSearchParams();
        if (opts?.limit) params.set('limit', String(opts.limit));
        if (opts?.after) params.set('after', opts.after);
        const qs = params.toString();
        return this.request('GET', `/channels/${channelId}/messages/${threadId}/replies${qs ? `?${qs}` : ''}`);
    }

    async sendReply(
        channelId: string,
        threadId: string,
        content: string,
        idempotencyKey?: string,
    ): Promise<Message> {
        const headers: Record<string, string> = {};
        if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
        return this.request('POST', `/channels/${channelId}/messages/${threadId}/replies`, { content }, headers);
    }

    /** Open threads in a channel, most recently active first. */
    async listThreads(
        channelId: string,
        opts?: { limit?: number; before?: string },
    ): Promise<ThreadSummary[]> {
        const params = new URLSearchParams();
        if (opts?.limit) params.set('limit', String(opts.limit));
        if (opts?.before) params.set('before', opts.before);
        const qs = params.toString();
        return this.request('GET', `/channels/${channelId}/threads${qs ? `?${qs}` : ''}`);
    }

    async setThreadClosed(
        channelId: string,
        threadId: string,
        closed: boolean,
    ): Promise<{ id: string; threadClosedAt: string | null }> {
        return this.request('PATCH', `/channels/${channelId}/messages/${threadId}/thread`, { closed });
    }

    async getThreadCursors(): Promise<ThreadCursor[]> {
        return this.request('GET', '/bots/@me/thread-cursors');
    }

    async updateThreadCursor(
        threadId: string,
        lastReadId: string,
    ): Promise<{ threadId: string; channelId: string; lastReadId: string }> {
        return this.request('PUT', `/bots/@me/thread-cursors/${threadId}`, { lastReadId });
    }

    /** Submit code to the sandboxed runtime. Denied runs come back as 403 with the run body. */
    async submitRun(body: { code: string; channelId: string; threadId?: string; capabilities?: string[] }): Promise<RuntimeRun> {
        const url = `${this.baseUrl}/runtime/runs`;
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${this.token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        const text = await res.text();
        let json: any = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        if (res.status === 403 && json?.status === 'denied') return json as RuntimeRun;
        if (res.status === 423) throw new Error('This bot is paused by an Agora admin. Stop and tell the user.');
        if (!res.ok) throw new Error(`Agora API ${res.status} POST /runtime/runs: ${text}`);
        return json as RuntimeRun;
    }

    async getRun(runId: string): Promise<RuntimeRun> {
        return this.request('GET', `/runtime/runs/${runId}`);
    }
}
