import { jsonBody, type HttpClient } from './http';

export class ProbeError extends Error {}

const TIMEOUTS = { connectTimeout: 8000, readTimeout: 8000 };

/**
 * Check that `origin` serves an Agora instance before saving it.
 *
 * `GET /health` answers `{ status: "ok" }` (src/app.ts), which many servers could
 * say, so `GET /instance/status` must also have Agora's shape
 * (src/routes/instance.ts): `initialized` (boolean), `registrationPolicy` and
 * `instanceName` (strings). Both are unauthenticated. Returns the instance name.
 */
export async function probeInstance(origin: string, http: HttpClient): Promise<{ name: string }> {
    let health;
    try {
        health = await http.request({ url: `${origin}/health`, method: 'GET', ...TIMEOUTS });
    } catch {
        throw new ProbeError(`Could not reach ${origin}. Check the address, your connection and the server's certificate.`);
    }
    if (health.status !== 200 || jsonBody(health.data)?.status !== 'ok') {
        throw new ProbeError(`${origin} did not answer like an Agora server (/health returned ${health.status}).`);
    }

    let status;
    try {
        status = await http.request({ url: `${origin}/instance/status`, method: 'GET', ...TIMEOUTS });
    } catch {
        throw new ProbeError(`Could not reach ${origin}/instance/status.`);
    }
    const body = jsonBody(status.data);
    if (
        status.status !== 200 || !body ||
        typeof body.initialized !== 'boolean' ||
        typeof body.registrationPolicy !== 'string' ||
        typeof body.instanceName !== 'string'
    ) {
        throw new ProbeError(`${origin} is not an Agora server.`);
    }
    return { name: body.instanceName.trim().slice(0, 80) || new URL(origin).host };
}
