import { useEffect, useState, useRef, useCallback } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
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
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null);
  const [banLoading, setBanLoading] = useState(false);
  const [banIp, setBanIp] = useState(false);
  const [banResult, setBanResult] = useState('');
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

  async function banUser() {
    if (!banTarget) return;
    setBanLoading(true);
    try {
      if (banIp) {
        const res = await api.post<{ user: AdminUser; accountBanned: boolean; ipBanned: boolean }>(
          `/admin/users/${banTarget.id}/ip-ban`
        );
        setUsers((prev) =>
          prev.map((u) =>
            u.id === banTarget.id ? { ...u, accountStatus: res.user.accountStatus } : u
          )
        );
        setBanResult(res.accountBanned ? 'IP banned and account banned' : 'IP banned');
      } else {
        await api.post(`/admin/users/${banTarget.id}/ban`);
        setUsers((prev) =>
          prev.map((u) =>
            u.id === banTarget.id ? { ...u, accountStatus: 'suspended' as const } : u
          )
        );
        setBanResult('Account banned');
      }
      setBanTarget(null);
      setBanIp(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to ban user');
    } finally {
      setBanLoading(false);
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
          <option value="suspended">Banned</option>
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
      {banResult && (
        <p className="text-online text-sm mb-4">
          {banResult}
          <button className="ml-2 underline text-text-muted" onClick={() => setBanResult('')}>dismiss</button>
        </p>
      )}

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
                  <td className="py-3 pr-4 text-text-muted">{user.email ?? '—'}</td>
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
                        onClick={() => { setBanTarget(user); setBanIp(false); setBanResult(''); }}
                      >
                        Ban
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

      <BanDialog
        target={banTarget}
        banIp={banIp}
        onBanIpChange={setBanIp}
        onConfirm={banUser}
        onCancel={() => { setBanTarget(null); setBanIp(false); }}
        loading={banLoading}
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

  const labels: Record<AdminUser['accountStatus'], string> = {
    active: 'active',
    pending: 'pending',
    suspended: 'Banned',
  };

  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded ${styles[status]}`}>
      {labels[status]}
    </span>
  );
}

function BanDialog({
  target,
  banIp,
  onBanIpChange,
  onConfirm,
  onCancel,
  loading,
}: {
  target: AdminUser | null;
  banIp: boolean;
  onBanIpChange: (v: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  loading: boolean;
}) {
  if (!target) return null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center">
      <div className="bg-surface rounded-lg border border-border p-6 max-w-md w-full mx-4">
        <h2 className="text-lg font-bold">Ban user</h2>
        <p className="text-text-muted text-sm mt-2">
          Are you sure you want to ban {target.username}?
        </p>
        {target.lastIp && (
          <label className="flex items-center gap-2 mt-4 text-sm text-text-muted cursor-pointer">
            <input
              type="checkbox"
              checked={banIp}
              onChange={(e) => onBanIpChange(e.target.checked)}
              className="rounded border-border"
            />
            Also ban IP address ({target.lastIp})
          </label>
        )}
        <div className="flex justify-end gap-2 mt-6">
          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={loading}>
            Ban
          </Button>
        </div>
      </div>
    </div>
  );
}
