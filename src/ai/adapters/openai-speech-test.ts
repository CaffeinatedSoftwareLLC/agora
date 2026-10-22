import type { ConnectionResult, ProviderCredentials } from './types';
import { apiError, joinUrl, networkError, refuseRedirect } from './sse';

/** Compatible speech servers expose /models but need not implement /chat/completions. */
export async function testOpenAISpeechConnection(creds: ProviderCredentials, model: string): Promise<ConnectionResult> {
    const signal = AbortSignal.timeout(15_000);
    const base = creds.baseUrl || 'https://api.openai.com/v1';
    try {
        const official = new URL(base).hostname.toLowerCase().replace(/\.$/, '') === 'api.openai.com';
        const res = await fetch(joinUrl(base, official && model ? `/models/${encodeURIComponent(model)}` : '/models'), {
            method: 'GET', signal, redirect: 'manual',
            headers: creds.apiKey ? { Authorization: `Bearer ${creds.apiKey}` } : {},
        });
        refuseRedirect(res, 'OpenAI speech');
        const result = res.ok ? { ok: true } : { ok: false, error: await apiError('OpenAI speech', res) };
        return signal.aborted ? { ok: false, error: 'timed out after 15 s' } : result;
    } catch (err) {
        return { ok: false, error: signal.aborted ? 'timed out after 15 s' : networkError(err) };
    }
}
