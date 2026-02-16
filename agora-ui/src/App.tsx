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
import { SocketProvider } from './features/shell/SocketProvider';
import { AppShell } from './features/shell/AppShell';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { DesignShowcase } from './features/design-showcase/DesignShowcase';

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Routes>
          {/* Design showcase — no auth or instance setup required */}
          <Route path="/designs" element={<DesignShowcase />} />

          {/* All other routes go through instance guard */}
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
                          <Route path="settings" element={<InstanceSettings />} />
                        </Routes>
                      </AdminLayout>
                    </AdminGuard>
                  </AuthGuard>
                } />
                <Route path="/app/*" element={
                  <AuthGuard>
                    <SocketProvider>
                      <AppShell />
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
