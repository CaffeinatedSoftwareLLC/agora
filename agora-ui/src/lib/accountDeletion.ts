import { startAuthentication } from '@simplewebauthn/browser';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { api } from './api';

/** Account deletion (docs/account-deletion.md). */

export type DeletedAccountMessages = 'anonymize' | 'remove';

export interface DeletionPreview {
  deletedAccountMessages: DeletedAccountMessages;
  passkeys: number;
  ownedServers: { id: string; name: string }[];
  lastAdmin: boolean;
  ownedBots: { id: string; username: string; serverId: string | null }[];
}

export type Reauth = { password: string } | { passkey: true };

export const accountDeletionApi = {
  preview: () => api.get<DeletionPreview>('/users/@me/deletion'),

  /** Delete the signed-in account. With a passkey, the browser asks for it first. */
  async deleteAccount(confirm: string, reauth: Reauth): Promise<{ deleted: true }> {
    if ('password' in reauth) return api.delete('/users/@me', { confirm, password: reauth.password });
    const { flowId, options } = await api.post<{ flowId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
      '/users/@me/deletion/passkey-options');
    const response = await startAuthentication({ optionsJSON: options });
    return api.delete('/users/@me', { confirm, passkey: { flowId, response } });
  },

  getSetting: () => api.get<{ deletedAccountMessages: DeletedAccountMessages }>('/admin/settings/accounts'),
  setSetting: (deletedAccountMessages: DeletedAccountMessages) =>
    api.patch<{ deletedAccountMessages: DeletedAccountMessages }>('/admin/settings/accounts', { deletedAccountMessages }),
};

/** A short message for a refused deletion. */
export function deletionErrorMessage(err: unknown): string | null {
  const name = (err as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return null;
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'reauth_failed': return 'That password or passkey is not right.';
    case 'challenge_invalid': return 'The request expired. Try again.';
    case 'confirmation_mismatch': return 'Type your username exactly as shown.';
    case 'owns_servers': return 'You own servers. Transfer or delete them first.';
    case 'last_admin': return 'You are the only instance admin. Make someone else an admin first.';
    case 'too_many_attempts': return 'Too many attempts. Wait 15 minutes and try again.';
    case 'no_passkeys': return 'You have no passkey for this address. Use your password.';
    case 'origin_not_allowed': return 'Passkeys are not enabled for this address. Use your password.';
    default: return code ?? (err instanceof Error ? err.message : 'Something went wrong.');
  }
}
