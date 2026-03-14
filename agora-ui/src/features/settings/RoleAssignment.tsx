import { useState, useEffect, useCallback } from 'react';
import type { Role } from '../../lib/contracts/roles';
import type { Member } from '../../lib/contracts/server';
import { roleApi, serverApi } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';

export function RoleAssignment() {
  const serverId = useServerStore((s) => s.instanceServerId) ?? '';
  const [roles, setRoles] = useState<Role[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [selectedMember, setSelectedMember] = useState<string>('');
  const [memberRoles, setMemberRoles] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadData = useCallback(async () => {
    if (!serverId) return;
    try {
      const [rolesData, membersData] = await Promise.all([
        roleApi.list(serverId),
        serverApi.getMembers(serverId),
      ]);
      setRoles(rolesData.filter((r) => !r.isEveryone));
      setMembers(membersData);
    } catch (e: any) {
      setError(e.message || 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  function selectMember(userId: string) {
    setSelectedMember(userId);
    setError('');
    // Use roles already returned in the member list
    const member = members.find((m) => m.id === userId);
    if (member) {
      setMemberRoles(new Set(member.roles.map((r) => r.id)));
    } else {
      setMemberRoles(new Set());
    }
  }

  async function toggleRole(roleId: string) {
    if (!selectedMember) return;
    setError('');
    try {
      if (memberRoles.has(roleId)) {
        await roleApi.removeRole(serverId, selectedMember, roleId);
        setMemberRoles((prev) => {
          const next = new Set(prev);
          next.delete(roleId);
          return next;
        });
      } else {
        await roleApi.assignRole(serverId, selectedMember, roleId);
        setMemberRoles((prev) => new Set([...prev, roleId]));
      }
    } catch (e: any) {
      setError(e.message || 'Failed to update role');
    }
  }

  if (loading) {
    return <p className="text-text-muted text-sm">Loading...</p>;
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold text-text mb-4">Role Assignment</h2>

      {error && (
        <div className="bg-red-500/20 text-red-300 px-3 py-2 rounded text-sm mb-4">
          {error}
        </div>
      )}

      <div className="mb-4">
        <label className="block text-sm text-text-muted mb-1">Select Member</label>
        <select
          value={selectedMember}
          onChange={(e) => selectMember(e.target.value)}
          className="w-full px-3 py-2 rounded bg-surface border border-border text-text"
        >
          <option value="">Choose a member...</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>
              {m.username}
            </option>
          ))}
        </select>
      </div>

      {selectedMember && roles.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold text-text-muted mb-2">Roles</h3>
          {roles.map((role) => (
            <label
              key={role.id}
              className="flex items-center gap-3 px-3 py-2 rounded hover:bg-surface-hover cursor-pointer"
            >
              <input
                type="checkbox"
                checked={memberRoles.has(role.id)}
                onChange={() => toggleRole(role.id)}
                className="accent-primary"
              />
              <span
                className="w-3 h-3 rounded-full"
                style={{ backgroundColor: role.color || '#99aab5' }}
              />
              <span className="text-sm text-text">{role.name}</span>
            </label>
          ))}
        </div>
      )}

      {selectedMember && roles.length === 0 && (
        <p className="text-text-muted text-sm">
          No custom roles yet. Create roles first in the Roles tab.
        </p>
      )}
    </div>
  );
}
