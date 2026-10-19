import { randomBytes } from 'crypto';
import type { FastifyRequest } from 'fastify';
import { config } from '../config';
import { getRedis } from './token-blacklist';

/**
 * Passkey (WebAuthn) support code. The ceremony itself is @simplewebauthn/server's;
 * this file only keeps challenges and works out which relying party a request is for.
 *
 * A passkey is bound to an RP ID, the hostname it was registered on. Agora can be
 * served from more than one hostname (https://localhost and a Tailscale name, say), so
 * the RP ID is taken from the request's Origin, which must be one of
 * config.webauthn.origins. A passkey registered on one hostname only works there.
 */

/** How long a registration or sign-in ceremony may take. */
export const CHALLENGE_TTL_SECONDS = 5 * 60;
const CHALLENGE_PREFIX = 'webauthn:flow:';

export interface Ceremony {
    purpose: 'register' | 'login';
    challenge: string;
    origin: string;
    rpID: string;
    /** Registration: who is adding the passkey. Sign-in: set only when a username was given. */
    userId?: string;
}

/** The allowed origin this request comes from and its RP ID, or null. */
export function relyingParty(request: FastifyRequest): { origin: string; rpID: string } | null {
    const origin = request.headers.origin;
    if (typeof origin !== 'string' || !config.webauthn.origins.includes(origin)) return null;
    try {
        return { origin, rpID: new URL(origin).hostname };
    } catch {
        return null;
    }
}

/** Keep a ceremony's challenge server-side; the client gets back an opaque flow id. */
export async function saveCeremony(ceremony: Ceremony): Promise<string> {
    const flowId = randomBytes(24).toString('base64url');
    await getRedis().set(CHALLENGE_PREFIX + flowId, JSON.stringify(ceremony), 'EX', CHALLENGE_TTL_SECONDS);
    return flowId;
}

/** Take a ceremony out of the store. Single use: a second take finds nothing. */
export async function takeCeremony(flowId: string, purpose: Ceremony['purpose']): Promise<Ceremony | null> {
    const raw = await getRedis().getdel(CHALLENGE_PREFIX + flowId);
    if (!raw) return null;
    const ceremony = JSON.parse(raw) as Ceremony;
    return ceremony.purpose === purpose ? ceremony : null;
}

/** Redis key of a flow, for tests that need to expire one early. */
export function ceremonyKey(flowId: string): string {
    return CHALLENGE_PREFIX + flowId;
}
