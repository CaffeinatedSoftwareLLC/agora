import { useState, useEffect } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { serverApi } from '../../lib/api';
import type { Member } from '../../lib/contracts/server';

export function MemberList() {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  // Keyed by server so a server switch shows "Loading" again without a setState inside the effect.
  const [loaded, setLoaded] = useState<{ serverId: string; members: Member[]; error: string | null } | null>(null);
  const current = loaded && loaded.serverId === instanceServerId ? loaded : null;
  const members = current?.members ?? [];
  const error = current?.error ?? null;
  const loading = !current;

  useEffect(() => {
    if (!instanceServerId) return;

    let cancelled = false;

    serverApi.getMembers(instanceServerId).then(data => {
      if (cancelled) return;
      setLoaded({ serverId: instanceServerId, members: data, error: null });
    }).catch(err => {
      if (cancelled) return;
      setLoaded({ serverId: instanceServerId, members: [], error: err.message || 'Failed to load members' });
    });

    return () => { cancelled = true; };
  }, [instanceServerId]);

  if (loading) {
    return <div className="text-text-muted">Loading members...</div>;
  }

  if (error) {
    return <div className="text-danger">{error}</div>;
  }

  return (
    <div>
      <h2 className="text-xl font-bold text-text mb-4">Members ({members.length})</h2>
      <div className="bg-surface rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-text-muted text-left">
              <th className="px-4 py-3 font-medium">Username</th>
              <th className="px-4 py-3 font-medium">Roles</th>
              <th className="px-4 py-3 font-medium">Joined</th>
            </tr>
          </thead>
          <tbody>
            {members.map(member => (
              <tr key={member.id} className="border-b border-border last:border-b-0">
                <td className="px-4 py-3 text-text font-medium">{member.username}</td>
                <td className="px-4 py-3">
                  <div className="flex gap-1 flex-wrap">
                    {member.roles.length > 0 ? (
                      member.roles.map(role => (
                        <span
                          key={role.id}
                          className="px-2 py-0.5 rounded text-xs bg-primary/20 text-primary-text"
                        >
                          {role.name}
                        </span>
                      ))
                    ) : (
                      <span className="text-text-muted">--</span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3 text-text-muted">
                  {new Date(member.joinedAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
