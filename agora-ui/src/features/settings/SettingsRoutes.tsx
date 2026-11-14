import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminGuard } from '../admin/AdminGuard';
import { InstanceSettings } from '../admin/InstanceSettings';
import { StorageSettings } from '../admin/StorageSettings';
import { AISettings } from './AISettings';
import { AddAgent } from './AddAgent';
import { AgentDetail } from './AgentDetail';
import { AgentsHome } from './AgentsHome';
import { ChannelOverrides } from './ChannelOverrides';
import { RoleAssignment } from './RoleAssignment';
import { RoleManagement } from './RoleManagement';

/** Everything under /settings. Old addresses redirect: Bots became Agents, AI became Models and assistant. */
export function SettingsRoutes() {
  return (
    <Routes>
      <Route index element={<Navigate to="/settings/roles" replace />} />
      <Route path="roles" element={<RoleManagement />} />
      <Route path="role-assign" element={<RoleAssignment />} />
      <Route path="overrides" element={<ChannelOverrides />} />
      {/* Old addresses keep working: Bots became Agents, AI became Models and assistant */}
      <Route path="bots" element={<Navigate to="/settings/agents" replace />} />
      <Route path="agents" element={<AgentsHome />} />
      <Route path="agents/new" element={<AddAgent />} />
      <Route path="agents/:agentKey" element={<AgentDetail />} />
      <Route path="models" element={<AISettings />} />
      <Route path="ai" element={<Navigate to="/settings/models" replace />} />
      <Route path="instance" element={<AdminGuard><InstanceSettings /></AdminGuard>} />
      <Route path="storage" element={<AdminGuard><StorageSettings /></AdminGuard>} />
    </Routes>
  );
}
