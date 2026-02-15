import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { serverApi, ApiError } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';

interface CreateServerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function CreateServerModal({ isOpen, onClose }: CreateServerModalProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const addServer = useServerStore((s) => s.addServer);
  const setActiveServer = useServerStore((s) => s.setActiveServer);
  const addChannel = useChannelStore((s) => s.addChannel);
  const setActiveChannel = useChannelStore((s) => s.setActiveChannel);
  const navigate = useNavigate();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    setLoading(true);
    setError('');

    try {
      const server = await serverApi.createServer(trimmed);

      addServer(server);
      setActiveServer(server.id);

      // Fetch channels for the new server so we can navigate to #general
      const channels = await serverApi.getChannels(server.id);
      for (const ch of channels) {
        addChannel(ch);
      }

      const general = channels[0];
      if (general) {
        setActiveChannel(general.id);
        navigate(`/app/${server.id}/${general.id}`);
      } else {
        navigate(`/app/${server.id}`);
      }

      setName('');
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.code);
      } else {
        setError('Failed to create server');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    if (loading) return;
    setName('');
    setError('');
    onClose();
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create a Server">
      <form onSubmit={handleSubmit}>
        <Input
          label="Server Name"
          placeholder="My Server"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
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
          <Button type="submit" loading={loading} disabled={!name.trim()}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
