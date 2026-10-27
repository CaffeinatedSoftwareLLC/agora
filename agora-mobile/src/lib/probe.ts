import { ProbeError, errorDetail } from './errors';
import { jsonBody, type HttpClient, type HttpResponse } from './http';

export { ProbeError } from './errors';

const TIMEOUTS = { connectTimeout: 8000, readTimeout: 8000 };

async function get(http: HttpClient, url: string): Promise<HttpResponse> {
    try {
        return await http.request({ url, method: 'GET', ...TIMEOUTS });
    } catch (err) {
        // No HTTP answer at all: network, VPN, DNS, refused, timeout or TLS.
        throw new ProbeError('unreachable', `GET ${url}: ${errorDetail(err)}`);
    }
}

/**
 * Check that `origin` serves an Agora instance before saving it.
 *
 * `GET /health` answers `{ status: "ok" }` (src/app.ts), which many servers could
 * say, so `GET /instance/status` must also have Agora's shape
 * (src/routes/instance.ts): `initialized` (boolean), `registrationPolicy` and
 * `instanceName` (strings). Both are unauthenticated. Returns the instance name.
 * Throws ProbeError: `unreachable` without an HTTP answer, `not_agora` for any
 * answer that is not Agora's (non-200 or the wrong shape).
 */
export async function probeInstance(origin: string, http: HttpClient): Promise<{ name: string }> {
    const health = await get(http, `${origin}/health`);
    if (health.status !== 200 || jsonBody(health.data)?.status !== 'ok') {
        throw new ProbeError('not_agora', `/health returned ${health.status}`);
    }

    const status = await get(http, `${origin}/instance/status`);
    const body = jsonBody(status.data);
    if (
        status.status !== 200 || !body ||
        typeof body.initialized !== 'boolean' ||
        typeof body.registrationPolicy !== 'string' ||
        typeof body.instanceName !== 'string'
    ) {
        throw new ProbeError('not_agora', `/instance/status returned ${status.status} without Agora's shape`);
    }
    return { name: body.instanceName.trim().slice(0, 80) || new URL(origin).host };
}
