import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { UserSearch } from './UserSearch';
import { dmApi, ApiError } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';
import { useChannelStore } from '../../stores/channelStore';
import { useNavigate } from 'react-router-dom';
import type { UserSearchResult } from '../../lib/contracts/server';

interface NewDMModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function NewDMModal({ isOpen, onClose }: NewDMModalProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const setActiveServer = useServerStore(s => s.setActiveServer);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);
  const addChannel = useChannelStore(s => s.addChannel);
  const navigate = useNavigate();

  const handleSelect = async (user: UserSearchResult) => {
    setLoading(true);
    setError('');
    try {
      const dm = await dmApi.createDM(user.id);
      addChannel({ id: dm.id, name: user.username, channelType: dm.channelType, serverId: null });
      setActiveServer(null);
      setActiveChannel(dm.id);
      navigate(`/app/dms/${dm.id}`);
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.code);
      } else {
        setError('Failed to create DM');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="New Message">
      <p className="text-text-muted text-sm mb-3">
        Search for a user to start a direct message.
      </p>
      <UserSearch onSelect={handleSelect} />
      {loading && (
        <p className="text-text-muted text-sm mt-3">Creating conversation...</p>
      )}
      {error && (
        <p className="text-danger text-sm mt-3">{error}</p>
      )}
    </Modal>
  );
}
