import { lazy, Suspense } from 'react';
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
import { ProviderTerms } from './features/admin/ProviderTerms';
import { SocketProvider } from './features/shell/SocketProvider';
import { AppShell } from './features/shell/AppShell';
import { ServerSettingsLayout } from './features/settings/ServerSettingsLayout';
import { ServerAdminGuard } from './features/settings/ServerAdminGuard';
import { SettingsRoutes } from './features/settings/SettingsRoutes';
import { useApplyPalette } from './theme/useApplyPalette';
import { ModerationGuard } from './features/moderation/ModerationGuard';
import { ModerationLayout } from './features/moderation/ModerationLayout';
import { MemberList } from './features/moderation/MemberList';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { AccountPage } from './features/account/AccountPage';
import { PageSpinner } from './components/ui/PageSpinner';
// xterm is large and only this route uses it
const BoxTerminalPage = lazy(() => import('./features/boxes/terminal/BoxTerminalPage').then(m => ({ default: m.BoxTerminalPage })));

export default function App() {
  useApplyPalette();
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
                          <Route path="provider-terms" element={<ProviderTerms />} />
                          <Route path="settings" element={<Navigate to="/settings/instance" replace />} />
                          <Route path="storage" element={<Navigate to="/settings/storage" replace />} />
                        </Routes>
                      </AdminLayout>
                    </AdminGuard>
                  </AuthGuard>
                } />
                <Route path="/account" element={<AuthGuard><AccountPage /></AuthGuard>} />
                {/* The terminal in a box: no SocketProvider and no shell, so no message or channel is on this page */}
                <Route path="/terminal/:boxId" element={<AuthGuard><Suspense fallback={<PageSpinner />}><BoxTerminalPage /></Suspense></AuthGuard>} />
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
                          <SettingsRoutes />
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
                {/* AuthGuard sends a signed-out visitor on to /login */}
                <Route path="*" element={<Navigate to="/app" replace />} />
              </Routes>
            </InstanceGuard>
          } />
        </Routes>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
