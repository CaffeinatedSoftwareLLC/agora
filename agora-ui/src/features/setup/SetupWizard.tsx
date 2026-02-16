import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { api, ApiError } from '../../lib/api';
import type { RegistrationPolicy } from '../../lib/contracts/instance';

interface SetupResponse {
  user: { id: string; username: string; isInstanceAdmin: boolean };
  accessToken: string;
}

export function SetupWizard({ onComplete }: { onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Form fields
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [instanceName, setInstanceName] = useState('Agora');
  const [registrationPolicy, setRegistrationPolicy] = useState<RegistrationPolicy>('open');

  const steps = ['Setup Token', 'Admin Account', 'Instance Settings'];

  const canAdvance = () => {
    if (step === 0) return setupToken.trim().length > 0;
    if (step === 1) return username.trim().length > 0 && email.trim().length > 0 && password.length >= 8 && password === confirmPassword;
    return true;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (step < 2) {
      setStep(step + 1);
      return;
    }

    setLoading(true);
    try {
      const res = await api.post<SetupResponse>('/instance/setup', {
        setupToken: setupToken.trim(),
        username: username.trim(),
        email: email.trim(),
        password,
        instanceName: instanceName.trim() || 'Agora',
        registrationPolicy,
      });

      // Store the token so the user is immediately authenticated
      const { useAuthStore } = await import('../../stores/authStore');
      useAuthStore.setState({
        token: res.accessToken,
        user: res.user,
        status: 'authenticated',
      });

      onComplete();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'invalid_setup_token') {
          setError('Invalid setup token. Check the server console output.');
          setStep(0);
        } else if (err.code === 'instance_already_initialized') {
          setError('This instance has already been set up.');
        } else {
          setError(err.code);
        }
      } else {
        setError('An unexpected error occurred.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen px-4">
      <div className="w-full max-w-md bg-surface rounded-lg p-8 border border-border">
        <h1 className="text-2xl font-bold text-center mb-2">Set Up Agora</h1>
        <p className="text-text-dim text-sm text-center mb-6">
          Complete the initial setup to get started.
        </p>

        {/* Step indicator */}
        <div className="flex items-center justify-center gap-2 mb-6">
          {steps.map((label, i) => (
            <div key={label} className="flex items-center gap-2">
              <div
                className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                  i <= step
                    ? 'bg-primary text-text'
                    : 'bg-surface-hover text-text-dim'
                }`}
              >
                {i + 1}
              </div>
              {i < steps.length - 1 && (
                <div className={`w-8 h-0.5 ${i < step ? 'bg-primary' : 'bg-border'}`} />
              )}
            </div>
          ))}
        </div>

        <p className="text-text-muted text-sm text-center mb-4 font-medium">
          {steps[step]}
        </p>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {step === 0 && (
            <>
              <Input
                label="Setup Token"
                type="text"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="Paste the token from server console"
                required
                autoFocus
              />
              <p className="text-text-dim text-xs">
                The setup token is printed in the server console when Agora starts for the first time.
              </p>
            </>
          )}

          {step === 1 && (
            <>
              <Input
                label="Username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                autoFocus
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
                autoComplete="new-password"
                error={password.length > 0 && password.length < 8 ? 'Minimum 8 characters' : undefined}
              />
              <Input
                label="Confirm Password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                autoComplete="new-password"
                error={confirmPassword.length > 0 && confirmPassword !== password ? 'Passwords do not match' : undefined}
              />
            </>
          )}

          {step === 2 && (
            <>
              <Input
                label="Instance Name"
                type="text"
                value={instanceName}
                onChange={(e) => setInstanceName(e.target.value)}
                placeholder="Agora"
                autoFocus
              />
              <div className="flex flex-col gap-1">
                <label className="text-sm text-text-muted">Registration Policy</label>
                <div className="flex flex-col gap-2">
                  {([
                    ['open', 'Open', 'Anyone can register'],
                    ['invite_only', 'Invite Only', 'Users need an invite code'],
                    ['approval', 'Approval', 'Admin must approve new accounts'],
                  ] as const).map(([value, label, desc]) => (
                    <label
                      key={value}
                      className={`flex items-start gap-3 p-3 rounded border cursor-pointer transition-colors ${
                        registrationPolicy === value
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:bg-surface-hover'
                      }`}
                    >
                      <input
                        type="radio"
                        name="registrationPolicy"
                        value={value}
                        checked={registrationPolicy === value}
                        onChange={() => setRegistrationPolicy(value)}
                        className="mt-0.5"
                      />
                      <div>
                        <div className="text-sm font-medium text-text">{label}</div>
                        <div className="text-xs text-text-dim">{desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {error && <p className="text-sm text-danger">{error}</p>}

          <div className="flex gap-2">
            {step > 0 && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => { setStep(step - 1); setError(''); }}
              >
                Back
              </Button>
            )}
            <Button
              type="submit"
              fullWidth
              loading={loading}
              disabled={!canAdvance()}
            >
              {step < 2 ? 'Next' : 'Complete Setup'}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
