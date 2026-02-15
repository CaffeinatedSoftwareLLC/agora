import { useEffect, useState, useRef, useCallback } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import type { AdminUser, PaginatedUsers } from '../../lib/contracts/admin';

type StatusFilter = 'all' | 'active' | 'pending' | 'suspended';

const LIMIT = 20;

export function UserTable() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [suspendTarget, setSuspendTarget] = useState<AdminUser | null>(null);
  const [suspendLoading, setSuspendLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const searchRef = useRef(search);
  searchRef.current = search;

  const fetchUsers = useCallback(async (p: number, s: StatusFilter, q: string) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(p), limit: String(LIMIT) });
      if (s !== 'all') params.set('status', s);
      if (q) params.set('search', q);
      const res = await api.get<PaginatedUsers>(`/admin/users?${params}`);
      setUsers(res.users);
      setTotal(res.total);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers(page, status, searchRef.current);
  }, [page, status, fetchUsers]);

  function handleSearchChange(value: string) {
    setSearch(value);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      fetchUsers(1, status, value);
    }, 300);
  }

  function handleStatusChange(value: StatusFilter) {
    setStatus(value);
    setPage(1);
  }

  async function suspendUser() {
    if (!suspendTarget) return;
    setSuspendLoading(true);
    try {
      await api.post(`/admin/users/${suspendTarget.id}/suspend`);
      setUsers((prev) =>
        prev.map((u) =>
          u.id === suspendTarget.id ? { ...u, accountStatus: 'suspended' as const } : u
        )
      );
      setSuspendTarget(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to suspend user');
    } finally {
      setSuspendLoading(false);
    }
  }

  const totalPages = Math.ceil(total / LIMIT);

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">All Users</h2>

      <div className="flex gap-3 mb-4">
        <select
          value={status}
          onChange={(e) => handleStatusChange(e.target.value as StatusFilter)}
          className="bg-surface border border-border rounded px-3 py-2 text-text text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="pending">Pending</option>
          <option value="suspended">Suspended</option>
        </select>
        <input
          type="text"
          placeholder="Search users..."
          value={search}
          onChange={(e) => handleSearchChange(e.target.value)}
          className="bg-surface border border-border rounded px-3 py-2 text-text text-sm placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary flex-1 max-w-xs"
        />
      </div>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th className="pb-2 pr-4">Username</th>
              <th className="pb-2 pr-4">Email</th>
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4">Admin</th>
              <th className="pb-2 pr-4">Joined</th>
              <th className="pb-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-text-muted">
                  Loading...
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-text-muted">
                  No users found.
                </td>
              </tr>
            ) : (
              users.map((user) => (
                <tr key={user.id} className="border-b border-border">
                  <td className="py-3 pr-4">{user.username}</td>
                  <td className="py-3 pr-4 text-text-muted">{user.email}</td>
                  <td className="py-3 pr-4">
                    <StatusChip status={user.accountStatus} />
                  </td>
                  <td className="py-3 pr-4">
                    {user.isInstanceAdmin && (
                      <span className="text-accent text-xs font-medium bg-accent/10 px-2 py-0.5 rounded">
                        Admin
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-4 text-text-muted">
                    {new Date(user.createdAt).toLocaleDateString()}
                  </td>
                  <td className="py-3">
                    {user.accountStatus === 'active' && !user.isInstanceAdmin && (
                      <Button
                        variant="danger"
                        className="text-xs px-2 py-1"
                        onClick={() => setSuspendTarget(user)}
                      >
                        Suspend
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <Button
            variant="secondary"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            Previous
          </Button>
          <span className="text-text-muted text-sm">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="secondary"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={suspendTarget !== null}
        title="Suspend user"
        message={`Are you sure you want to suspend ${suspendTarget?.username}?`}
        confirmLabel="Suspend"
        variant="danger"
        onConfirm={suspendUser}
        onCancel={() => setSuspendTarget(null)}
        loading={suspendLoading}
      />
    </div>
  );
}

function StatusChip({ status }: { status: AdminUser['accountStatus'] }) {
  const styles = {
    active: 'text-online bg-online/10',
    pending: 'text-warn bg-warn/10',
    suspended: 'text-danger bg-danger/10',
  };

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${styles[status]}`}>
      {status}
    </span>
  );
}
