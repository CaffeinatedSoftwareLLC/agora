/** The subset of CapacitorHttp the shell uses (native HTTP: no CORS, no page cookies). */
export interface HttpRequest {
    url: string;
    method: 'GET' | 'POST' | 'DELETE';
    headers?: Record<string, string>;
    data?: unknown;
    connectTimeout?: number;
    readTimeout?: number;
}

export interface HttpResponse {
    status: number;
    data: unknown;
}

export interface HttpClient {
    request(options: HttpRequest): Promise<HttpResponse>;
}

/** CapacitorHttp returns parsed JSON for JSON responses and a string otherwise. */
export function jsonBody(data: unknown): Record<string, unknown> | null {
    let value = data;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
