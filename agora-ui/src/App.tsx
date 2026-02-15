import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { InstanceGuard } from './features/setup/InstanceGuard';
import { AuthGuard } from './features/auth/AuthGuard';
import { LoginPage } from './features/auth/LoginPage';
import { RegisterPage } from './features/auth/RegisterPage';
import { PendingApprovalPage } from './features/auth/PendingApprovalPage';

function AppPlaceholder() {
  return <div className="flex items-center justify-center h-screen text-text-muted">App shell coming in Phase 3</div>;
}

export default function App() {
  return (
    <BrowserRouter>
      <InstanceGuard>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/pending" element={<PendingApprovalPage />} />
          <Route path="/app/*" element={<AuthGuard><AppPlaceholder /></AuthGuard>} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </InstanceGuard>
    </BrowserRouter>
  );
}
