export interface BotInfo {
    id: string;
    username: string;
    serverId: string;
    bot: boolean;
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
}

export interface Cursor {
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
}
