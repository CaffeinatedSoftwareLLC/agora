import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import type { InstanceStatus, RegistrationPolicy } from '../../lib/contracts/instance';

const policyOptions: { value: RegistrationPolicy; label: string; description: string }[] = [
  { value: 'open', label: 'Open', description: 'Anyone can register' },
  { value: 'invite_only', label: 'Invite Only', description: 'Users need an invite code to register' },
  { value: 'approval', label: 'Approval Required', description: 'New registrations require admin approval' },
];

export function InstanceSettings() {
  const [instanceName, setInstanceName] = useState('');
  const [registrationPolicy, setRegistrationPolicy] = useState<RegistrationPolicy>('open');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    api.get<InstanceStatus>('/instance/status')
      .then((res) => {
        setInstanceName(res.instanceName);
        setRegistrationPolicy(res.registrationPolicy);
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.code : 'Failed to load settings');
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await api.patch('/admin/instance', { instanceName, registrationPolicy });
      setSuccess('Settings saved.');
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className="text-text-muted">Loading settings...</p>;
  }

  return (
    <div>
      <h2 className="text-xl font-bold mb-4">Instance Settings</h2>

      <form onSubmit={handleSave} className="max-w-lg flex flex-col gap-5">
        <Input
          label="Instance Name"
          value={instanceName}
          onChange={(e) => setInstanceName(e.target.value)}
        />

        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm text-text-muted mb-2">Registration Policy</legend>
          {policyOptions.map((opt) => (
            <label
              key={opt.value}
              className={`flex items-start gap-3 p-3 rounded border cursor-pointer ${
                registrationPolicy === opt.value
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:bg-surface-hover'
              }`}
            >
              <input
                type="radio"
                name="registrationPolicy"
                value={opt.value}
                checked={registrationPolicy === opt.value}
                onChange={() => setRegistrationPolicy(opt.value)}
                className="mt-1"
              />
              <div>
                <p className="text-sm font-medium">{opt.label}</p>
                <p className="text-text-muted text-xs">{opt.description}</p>
              </div>
            </label>
          ))}
        </fieldset>

        {error && <p className="text-danger text-sm">{error}</p>}
        {success && <p className="text-online text-sm">{success}</p>}

        <Button type="submit" loading={saving}>
          Save Settings
        </Button>
      </form>
    </div>
  );
}
