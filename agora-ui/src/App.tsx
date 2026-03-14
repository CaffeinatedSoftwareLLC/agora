import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { InstanceGuard } from './features/setup/InstanceGuard';
import { AuthGuard } from './features/auth/AuthGuard';
import { LoginPage } from './features/auth/LoginPage';
import { RegisterPage } from './features/auth/RegisterPage';
import { PendingApprovalPage } from './features/auth/PendingApprovalPage';
import { AdminGuard } from './features/admin/AdminGuard';
import { AdminLayout } from './features/admin/AdminLayout';
import { AdminDashboard } from './features/admin/AdminDashboard';
import { PendingQueue } from './features/admin/PendingQueue';
import { UserTable } from './features/admin/UserTable';
import { InstanceSettings } from './features/admin/InstanceSettings';
import { StorageSettings } from './features/admin/StorageSettings';
import { SocketProvider } from './features/shell/SocketProvider';
import { AppShell } from './features/shell/AppShell';
import { ServerSettingsLayout } from './features/settings/ServerSettingsLayout';
import { ServerAdminGuard } from './features/settings/ServerAdminGuard';
import { BotManagement } from './features/settings/BotManagement';
import { AISettings } from './features/settings/AISettings';
import { RoleManagement } from './features/settings/RoleManagement';
import { RoleAssignment } from './features/settings/RoleAssignment';
import { ChannelOverrides } from './features/settings/ChannelOverrides';
import { ModerationGuard } from './features/moderation/ModerationGuard';
import { ModerationLayout } from './features/moderation/ModerationLayout';
import { MemberList } from './features/moderation/MemberList';
import { ErrorBoundary } from './components/ui/ErrorBoundary';

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          {/* All routes go through instance guard */}
          <Route path="*" element={
            <InstanceGuard>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/register" element={<RegisterPage />} />
                <Route path="/pending" element={<PendingApprovalPage />} />
                <Route path="/admin/*" element={
                  <AuthGuard>
                    <AdminGuard>
                      <AdminLayout>
                        <Routes>
                          <Route index element={<AdminDashboard />} />
                          <Route path="pending" element={<PendingQueue />} />
                          <Route path="users" element={<UserTable />} />
                          <Route path="settings" element={<Navigate to="/settings/instance" replace />} />
                          <Route path="storage" element={<Navigate to="/settings/storage" replace />} />
                        </Routes>
                      </AdminLayout>
                    </AdminGuard>
                  </AuthGuard>
                } />
                {/* Shared SocketProvider for /app and /settings */}
                <Route path="/app/*" element={
                  <AuthGuard>
                    <SocketProvider>
                      <AppShell />
                    </SocketProvider>
                  </AuthGuard>
                } />
                <Route path="/settings/*" element={
                  <AuthGuard>
                    <SocketProvider>
                      <ServerAdminGuard>
                        <ServerSettingsLayout>
                          <Routes>
                            <Route index element={<Navigate to="/settings/roles" replace />} />
                            <Route path="roles" element={<RoleManagement />} />
                            <Route path="role-assign" element={<RoleAssignment />} />
                            <Route path="overrides" element={<ChannelOverrides />} />
                            <Route path="bots" element={<BotManagement />} />
                            <Route path="ai" element={<AISettings />} />
                            <Route path="instance" element={<AdminGuard><InstanceSettings /></AdminGuard>} />
                            <Route path="storage" element={<AdminGuard><StorageSettings /></AdminGuard>} />
                          </Routes>
                        </ServerSettingsLayout>
                      </ServerAdminGuard>
                    </SocketProvider>
                  </AuthGuard>
                } />
                <Route path="/moderation/*" element={
                  <AuthGuard>
                    <SocketProvider>
                      <ModerationGuard>
                        <ModerationLayout>
                          <Routes>
                            <Route index element={<Navigate to="/moderation/members" replace />} />
                            <Route path="members" element={<MemberList />} />
                          </Routes>
                        </ModerationLayout>
                      </ModerationGuard>
                    </SocketProvider>
                  </AuthGuard>
                } />
                <Route path="*" element={<Navigate to="/login" replace />} />
              </Routes>
            </InstanceGuard>
          } />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
