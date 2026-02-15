import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { useInstance } from '../../hooks/useInstance';
import { ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

export function RegisterPage() {
  const navigate = useNavigate();
  const { data: instance } = useInstance();
  const { register, status } = useAuthStore();

  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState('');

  const isInviteOnly = instance?.registrationPolicy === 'invite_only';
  const isApproval = instance?.registrationPolicy === 'approval';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    try {
      await register({
        username,
        email,
        password,
        ...(inviteCode ? { inviteCode } : {}),
      });
      const currentStatus = useAuthStore.getState().status;
      if (currentStatus === 'pending') {
        navigate('/pending');
      } else {
        navigate('/app');
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'email_taken') {
          setError('An account with this email already exists.');
        } else if (err.code === 'username_taken') {
          setError('This username is already taken.');
        } else if (err.code === 'invalid_invite') {
          setError('Invalid or expired invite code.');
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
          Create Account
        </h1>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Input
            label="Username"
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
            autoComplete="username"
          />

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
            minLength={8}
            autoComplete="new-password"
          />

          {isInviteOnly && (
            <Input
              label="Invite Code"
              type="text"
              value={inviteCode}
              onChange={(e) => setInviteCode(e.target.value)}
              required
            />
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          {isApproval && (
            <p className="text-sm text-text-dim">
              Accounts on this instance require administrator approval before you can sign in.
            </p>
          )}

          <Button type="submit" fullWidth loading={status === 'loading'}>
            {isApproval ? 'Request Access' : 'Create Account'}
          </Button>
        </form>

        <p className="text-center text-text-muted text-sm mt-4">
          Already have an account?{' '}
          <Link to="/login" className="text-accent hover:underline">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
