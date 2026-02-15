import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { Button } from '../../components/ui/Button';

export function PendingApprovalPage() {
  const navigate = useNavigate();
  const { logout } = useAuthStore();

  const handleBackToLogin = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-md bg-surface rounded-lg p-8 border border-border text-center">
        <h1 className="text-2xl font-bold mb-4">Account Pending Review</h1>
        <p className="text-text-muted mb-6">
          Your account is being reviewed by an administrator. You will be able to sign in once your account is approved.
        </p>

        <div className="flex flex-col gap-3">
          <Button variant="secondary" fullWidth onClick={handleBackToLogin}>
            Back to login
          </Button>
        </div>
      </div>
    </div>
  );
}
