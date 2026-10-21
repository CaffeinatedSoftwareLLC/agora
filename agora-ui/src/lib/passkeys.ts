import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api } from './api';
import type { AuthResponse } from './contracts/auth';
import { signInErrorMessage } from './auth-errors';

/**
 * Passkeys (#78). The browser ceremony is @simplewebauthn/browser's; the server
 * verifies with @simplewebauthn/server. A passkey belongs to the hostname it was
 * added on: one added at https://localhost does not work at a Tailscale name.
 */

export interface Passkey {
  id: string;
  name: string;
  rpId: string;
  deviceType: string;
  backedUp: boolean;
  createdAt: string;
  lastUsedAt: string | null;
}

export const passkeysSupported = (): boolean => {
  try { return browserSupportsWebAuthn(); } catch { return false; }
};

export const passkeyApi = {
  list: () => api.get<{ passkeys: Passkey[] }>('/auth/passkeys').then(r => r.passkeys),
  remove: (id: string) => api.delete<void>(`/auth/passkeys/${id}`),
  async add(name: string): Promise<Passkey> {
    const { flowId, options } = await api.post<{ flowId: string; options: PublicKeyCredentialCreationOptionsJSON }>('/auth/passkeys/register/options');
    const response = await startRegistration({ optionsJSON: options });
    const res = await api.post<{ passkey: Passkey }>('/auth/passkeys/register/verify', { flowId, name, response });
    return res.passkey;
  },
  /** Sign in. With no login, any passkey saved for this site may answer. */
  async signIn(login?: string): Promise<AuthResponse> {
    const { flowId, options } = await api.post<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
      '/auth/passkeys/login/options', login ? { login } : {});
    const response = await startAuthentication({ optionsJSON: options });
    return api.post<AuthResponse>('/auth/passkeys/login/verify', { flowId, response });
  },
};

/** A short message for a failed ceremony. The user cancelling is not an error worth showing. */
export function passkeyErrorMessage(err: unknown): string | null {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'invalid_credentials': return 'That passkey is not registered here. Passkeys only work on the address they were added on.';
    case 'challenge_invalid': return 'The request expired. Try again.';
    case 'origin_not_allowed': return 'Passkeys are not enabled for this address. Ask the admin to add it to WEBAUTHN_ORIGINS.';
    case 'passkey_exists': return 'That passkey is already registered.';
    case 'too_many_passkeys': return 'You have reached the passkey limit. Remove one first.';
    case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED': return 'That passkey is already registered.';
    // account_suspended, too_many_attempts, login_unavailable: worded the same as the password form
    default: return signInErrorMessage(code) ?? code ?? (err instanceof Error ? err.message : 'Something went wrong.');
  }
}
