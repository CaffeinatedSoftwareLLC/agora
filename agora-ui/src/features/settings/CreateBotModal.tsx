import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { botApi, ApiError } from '../../lib/api';

interface CreateBotModalProps {
  serverId: string;
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateBotModal({ serverId, isOpen, onClose, onCreated }: CreateBotModalProps) {
  const [username, setUsername] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) return;
    setLoading(true);
    setError('');
    try {
      await botApi.create(serverId, username.trim());
      setUsername('');
      onCreated();
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.status === 409 ? 'Username already taken' : err.code);
      } else {
        setError('Failed to create bot');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Create Bot">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          label="Bot Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="e.g. build-bot"
          maxLength={32}
        />
        {error && <p className="text-danger text-sm">{error}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading} disabled={!username.trim()}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
