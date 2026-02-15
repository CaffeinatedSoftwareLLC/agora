import { useState, useEffect, useCallback } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { serverApi, ApiError } from '../../lib/api';

interface InviteModalProps {
  serverId: string;
  isOpen: boolean;
  onClose: () => void;
}

export function InviteModal({ serverId, isOpen, onClose }: InviteModalProps) {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const generateInvite = useCallback(async () => {
    setLoading(true);
    try {
      const res = await serverApi.createInvite(serverId);
      setCode(res.code);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.code);
      } else {
        setError('Failed to create invite');
      }
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  useEffect(() => {
    if (!isOpen) return;
    setCode('');
    setError('');
    setCopied(false);
    generateInvite();
  }, [isOpen, serverId, generateInvite]);

  const handleCopy = async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback: select the text
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Invite People">
      {error ? (
        <p className="text-danger text-sm">{error}</p>
      ) : loading ? (
        <p className="text-text-muted text-sm">Generating invite code...</p>
      ) : (
        <>
          <p className="text-text-muted text-sm mb-3">
            Share this invite code with others to let them join your server.
          </p>
          <div className="flex gap-2">
            <div className="flex-1 bg-bg border border-border rounded px-3 py-2 text-text font-mono text-lg select-all">
              {code}
            </div>
            <Button onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
