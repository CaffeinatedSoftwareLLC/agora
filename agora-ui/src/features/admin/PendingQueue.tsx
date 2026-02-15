import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import type { PendingUser, PaginatedUsers } from '../../lib/contracts/admin';

export function PendingQueue() {
  const [users, setUsers] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [rejectTarget, setRejectTarget] = useState<PendingUser | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    api.get<PaginatedUsers<PendingUser>>('/admin/pending-users')
      .then((res) => setUsers(res.users))
      .catch((err) => {
        setError(err instanceof ApiError ? err.code : 'Failed to load pending users');
      })
      .finally(() => setLoading(false));
  }, []);

  async function approve(userId: string) {
    setActionLoading(userId);
    try {
      await api.post(`/admin/approve-user/${userId}`);
      setUsers((prev) => prev.filter((u) => u.id !== userId));
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to approve user');
    } finally {
      setActionLoading(null);
    }
  }

  async function reject() {
    if (!rejectTarget) return;
    setActionLoading(rejectTarget.id);
    try {
      await api.post(`/admin/reject-user/${rejectTarget.id}`);
      setUsers((prev) => prev.filter((u) => u.id !== rejectTarget.id));
      setRejectTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to reject user');
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return <p className="text-text-muted">Loading pending users...</p>;
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Pending Users</h2>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      {users.length === 0 ? (
        <p className="text-text-muted">No pending users.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {users.map((user) => (
            <div
              key={user.id}
              className="bg-surface rounded-lg border border-border p-4 flex items-center justify-between"
            >
              <div>
                <p className="font-bold">{user.username}</p>
                <p className="text-text-muted text-sm">{user.email}</p>
                <p className="text-text-dim text-xs">
                  Registered {new Date(user.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="primary"
                  onClick={() => approve(user.id)}
                  loading={actionLoading === user.id}
                  disabled={actionLoading !== null}
                >
                  Approve
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setRejectTarget(user)}
                  disabled={actionLoading !== null}
                >
                  Reject
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={rejectTarget !== null}
        title="Reject user"
        message={`Are you sure you want to reject ${rejectTarget?.username}? This will delete their account.`}
        confirmLabel="Reject"
        variant="danger"
        onConfirm={reject}
        onCancel={() => setRejectTarget(null)}
        loading={actionLoading !== null}
      />
    </div>
  );
}
