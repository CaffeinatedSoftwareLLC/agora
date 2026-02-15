import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import type { AdminStats } from '../../lib/contracts/admin';

export function AdminDashboard() {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get<AdminStats>('/admin/stats').then(setStats).catch((err) => {
      setError(err instanceof ApiError ? err.code : 'Failed to load stats');
    });
  }, []);

  if (error) {
    return <p className="text-danger">{error}</p>;
  }

  if (!stats) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="bg-surface rounded-lg border border-border p-4 animate-pulse">
            <div className="h-4 bg-surface-hover rounded w-24 mb-2" />
            <div className="h-8 bg-surface-hover rounded w-16" />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Dashboard</h2>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard label="Total Users" value={stats.totalUsers} />
        <div className="bg-surface rounded-lg border border-border p-4">
          <p className="text-text-muted text-sm">Pending Approvals</p>
          <p className={`text-2xl font-bold ${stats.pendingCount > 0 ? 'text-warn' : ''}`}>
            {stats.pendingCount}
          </p>
          {stats.pendingCount > 0 && (
            <Link to="/admin/pending" className="text-accent text-sm hover:underline">
              Review pending users
            </Link>
          )}
        </div>
        <StatCard label="Servers" value={stats.serverCount} />
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-surface rounded-lg border border-border p-4">
      <p className="text-text-muted text-sm">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
