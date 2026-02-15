import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { serverApi, ApiError } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';

interface JoinServerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function JoinServerModal({ isOpen, onClose }: JoinServerModalProps) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const setActiveServer = useServerStore(s => s.setActiveServer);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;

    setLoading(true);
    setError('');

    try {
      const result = await serverApi.joinServer(trimmed);
      // Navigate to the joined server — ServerJoin WS event will hydrate channels
      setActiveServer(result.serverId);
      navigate(`/app/${result.serverId}`);
      setCode('');
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'already_member') {
          setError('You are already a member of this server');
        } else if (err.code === 'invite_not_found' || err.status === 404) {
          setError('Invalid or expired invite code');
        } else {
          setError(err.code);
        }
      } else {
        setError('Failed to join server');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (loading) return;
    setCode('');
    setError('');
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Join a Server">
      <form onSubmit={handleSubmit}>
        <Input
          label="Invite Code"
          placeholder="Enter an invite code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          error={error}
        />
        <div className="flex justify-end gap-2 mt-6">
          <Button
            type="button"
            variant="secondary"
            onClick={handleClose}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button type="submit" loading={loading} disabled={!code.trim()}>
            Join
          </Button>
        </div>
      </form>
    </Modal>
  );
}
