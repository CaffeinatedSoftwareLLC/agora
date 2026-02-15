import { useState, type FormEvent } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { serverApi } from '../../lib/api';
import { useChannelStore } from '../../stores/channelStore';

interface CreateChannelModalProps {
  serverId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function CreateChannelModal({ serverId, isOpen, onClose }: CreateChannelModalProps) {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const addChannel = useChannelStore(s => s.addChannel);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);

  const handleClose = () => {
    setName('');
    setError('');
    onClose();
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    const trimmed = name.trim();
    if (!trimmed) {
      setError('Channel name is required');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const channel = await serverApi.createChannel(serverId, trimmed, 3);
      addChannel(channel);
      setActiveChannel(channel.id);
      setName('');
      onClose();
    } catch {
      setError('Failed to create channel');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Channel">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <Input
          label="Channel Name"
          placeholder="general"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={error}
          maxLength={100}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" type="button" onClick={handleClose}>
            Cancel
          </Button>
          <Button type="submit" loading={loading}>
            Create
          </Button>
        </div>
      </form>
    </Modal>
  );
}
