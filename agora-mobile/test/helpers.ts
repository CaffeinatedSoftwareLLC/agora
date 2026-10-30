import { vi } from 'vitest';
import type { HttpRequest, HttpResponse } from '../src/lib/http';
import type { KeyValueStore } from '../src/lib/servers';

/** An in-memory stand-in for @capacitor/preferences. */
export function memoryKv(initial: Record<string, string> = {}): KeyValueStore & { data: Map<string, string> } {
    const data = new Map(Object.entries(initial));
    return {
        data,
        async get({ key }) { return { value: data.get(key) ?? null }; },
        async set({ key, value }) { data.set(key, value); },
        async remove({ key }) { data.delete(key); },
    };
}

/** A stand-in for CapacitorHttp answering from a URL → response table. */
export function fakeHttp(routes: Record<string, HttpResponse | Error | ((o: HttpRequest) => HttpResponse)>) {
    return {
        request: vi.fn(async (o: HttpRequest): Promise<HttpResponse> => {
            const r = routes[o.url];
            if (!r) return { status: 404, data: '' };
            if (r instanceof Error) throw r;
            return typeof r === 'function' ? r(o) : r;
        }),
    };
}
