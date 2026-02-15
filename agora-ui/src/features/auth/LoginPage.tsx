import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useInstance } from '../../hooks/useInstance';
import { ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

export function LoginPage() {
  const navigate = useNavigate();
  const { data: instance } = useInstance();
  const { login, status } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      await login(email, password);
      const currentStatus = useAuthStore.getState().status;
      if (currentStatus === 'pending') {
        navigate('/pending');
      } else {
        navigate('/app');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'account_suspended') {
          setError('Your account has been suspended. Contact an administrator.');
        } else if (err.code === 'invalid_credentials') {
          setError('Invalid email or password.');
        } else {
          setError(err.code);
        }
      } else {
        setError('An unexpected error occurred.');
      }
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-md bg-surface rounded-lg p-8 border border-border">
        <h1 className="text-2xl font-bold text-center mb-6">
          {instance?.instanceName || 'Agora'}
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="email"
          />

          <Input
            label="Password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoComplete="current-password"
          />

          {error && <p className="text-sm text-danger">{error}</p>}

          <Button type="submit" fullWidth loading={status === 'loading'}>
            Sign in
          </Button>
        </form>

        {instance?.registrationPolicy !== 'invite_only' && (
          <p className="text-center text-text-muted text-sm mt-4">
            Don't have an account?{' '}
            <Link to="/register" className="text-accent hover:underline">
              Register
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
