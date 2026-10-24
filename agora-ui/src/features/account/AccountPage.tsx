import { Link } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { PasskeySettings } from './PasskeySettings';
import { ReadAloudSettings } from '../voice/ReadAloudSettings';
import { DeleteAccount } from './DeleteAccount';

/** Settings → Account & security, for the signed-in user (not a server setting). */
export function AccountPage() {
  const user = useAuthStore(s => s.user);
  return (
    <div className="min-h-screen px-4 py-8">
      <div className="mx-auto w-full max-w-2xl flex flex-col gap-6">
        <div className="flex items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Account &amp; security</h1>
          <Link to="/app" className="min-h-11 md:min-h-8 inline-flex items-center px-2 text-sm text-accent hover:underline">
            Back to Agora
          </Link>
        </div>
        <p className="text-sm text-text-muted">
          Signed in as <span className="font-medium text-text">{user?.username}</span>. A browser session ends after
          24 hours without activity, and 30 days after you signed in.
        </p>
        <div className="bg-surface rounded-lg p-6 border border-border">
          <PasskeySettings />
        </div>
        <div className="bg-surface rounded-lg p-6 border border-border">
          <ReadAloudSettings />
        </div>
        <div className="bg-surface rounded-lg p-6 border border-border">
          <DeleteAccount />
        </div>
      </div>
    </div>
  );
}
