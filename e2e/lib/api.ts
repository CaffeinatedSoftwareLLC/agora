/** Minimal API client for seeding and API-level assertions (Bearer / Bot / AgentHost auth). */
export class Api {
    constructor(public base: string, public auth?: string) {}

    with(auth: string) { return new Api(this.base, auth); }

    async req<T = any>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: T }> {
        const headers: Record<string, string> = { ...extra };
        if (this.auth) headers.Authorization = this.auth;
        let payload: BodyInit | undefined;
        if (body instanceof FormData) payload = body;
        else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
        const res = await fetch(this.base + path, { method, headers, body: payload });
        const text = await res.text();
        let data: any = text;
        try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
        return { status: res.status, data };
    }

    /** Like req, but throws on an unexpected status (message never includes request headers). */
    async ok<T = any>(method: string, path: string, body?: unknown, expect: number[] = [200, 201, 204]): Promise<T> {
        const r = await this.req<T>(method, path, body);
        if (!expect.includes(r.status)) {
            throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
        }
        return r.data;
    }
}
