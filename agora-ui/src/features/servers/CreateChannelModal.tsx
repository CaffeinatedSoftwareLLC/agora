import { useState, useEffect, type FormEvent } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Input } from '../../components/ui/Input';
import { Button } from '../../components/ui/Button';
import { serverApi } from '../../lib/api';
import { useChannelStore } from '../../stores/channelStore';
import { usePalette, hexToRgb } from '../../theme';

const CHANNEL_TYPES = [
  { value: 3, label: 'Text', icon: 'hash' },
  { value: 4, label: 'Voice', icon: 'speaker' },
] as const;

interface CreateChannelModalProps {
  serverId: string;
  isOpen: boolean;
  onClose: () => void;
  defaultType?: 3 | 4;
}

export function CreateChannelModal({ serverId, isOpen, onClose, defaultType = 3 }: CreateChannelModalProps) {
  const [name, setName] = useState('');
  const [channelType, setChannelType] = useState<3 | 4>(defaultType);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const P = usePalette();

  const addChannel = useChannelStore(s => s.addChannel);
  const setActiveChannel = useChannelStore(s => s.setActiveChannel);

  // Sync channelType when defaultType changes (e.g. opening from different category)
  useEffect(() => {
    if (isOpen) setChannelType(defaultType);
  }, [isOpen, defaultType]);

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
      const channel = await serverApi.createChannel(serverId, trimmed, channelType);
      addChannel(channel);
      // Only navigate into text channels; voice channels are joined by clicking
      if (channelType === 3) {
        setActiveChannel(channel.id);
      }
      setName('');
      onClose();
    } catch {
      setError('Failed to create channel');
    } finally {
      setLoading(false);
    }
  };

  const accentRgb = hexToRgb(P.accent);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Create Channel">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        {/* Channel type selector */}
        <div className="flex flex-col gap-1">
          <span className="text-sm" style={{ color: P.muted }}>Channel Type</span>
          <div className="flex gap-2">
            {CHANNEL_TYPES.map((ct) => {
              const isSelected = channelType === ct.value;
              return (
                <button
                  key={ct.value}
                  type="button"
                  onClick={() => setChannelType(ct.value)}
                  className="flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded text-sm font-medium transition-all duration-150"
                  style={{
                    background: isSelected ? `rgba(${accentRgb}, 0.15)` : P.surface,
                    border: `1px solid ${isSelected ? P.accent : P.border}`,
                    color: isSelected ? P.text : P.muted,
                  }}
                >
                  {ct.icon === 'hash' ? (
                    <span className="text-base leading-none font-bold" style={{ color: isSelected ? P.accent : P.dim }}>#</span>
                  ) : (
                    <svg
                      className="h-4 w-4 shrink-0"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ color: isSelected ? P.accent : P.dim }}
                    >
                      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                      <path d="M15.54 8.46a5 5 0 010 7.07" />
                    </svg>
                  )}
                  {ct.label}
                </button>
              );
            })}
          </div>
        </div>

        <Input
          label="Channel Name"
          placeholder={channelType === 3 ? 'general' : 'lounge'}
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
