import { useState, useEffect, useRef } from 'react';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { botApi, ApiError } from '../../lib/api';

interface CreateTokenModalProps {
  serverId: string;
  botId: string;
  isOpen: boolean;
  onClose: () => void;
  onCreated: () => void;
}

export function CreateTokenModal({ serverId, botId, isOpen, onClose, onCreated }: CreateTokenModalProps) {
  // One outcome per open; "loading" is simply "open and no outcome yet", so the effect never resets state.
  const [result, setResult] = useState<{ token: string } | { error: string } | null>(null);
  const rawToken = result && 'token' in result ? result.token : '';
  const error = result && 'error' in result ? result.error : '';
  const loading = isOpen && result === null;
  const [copied, setCopied] = useState(false);
  const didFetch = useRef(false);
  const onCreatedRef = useRef(onCreated);
  useEffect(() => { onCreatedRef.current = onCreated; }, [onCreated]);

  useEffect(() => {
    if (!isOpen) {
      didFetch.current = false;
      return;
    }
    if (didFetch.current) return;
    didFetch.current = true;

    let cancelled = false;
    botApi.createToken(serverId, botId)
      .then((res) => {
        if (cancelled) return;
        setResult({ token: res.token });
        onCreatedRef.current();
      })
      .catch((err) => {
        if (cancelled) return;
        setResult({ error: err instanceof ApiError ? err.code : 'Failed to create token' });
      });

    return () => { cancelled = true; };
  }, [isOpen, serverId, botId]);

  function handleClose() {
    setResult(null);
    setCopied(false);
    onClose();
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(rawToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={rawToken ? 'Token Created' : 'Creating Token'}>
      {loading && (
        <p className="text-text-muted text-sm">Generating token...</p>
      )}
      {error && (
        <>
          <p className="text-danger text-sm mb-4">{error}</p>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={handleClose}>Close</Button>
          </div>
        </>
      )}
      {rawToken && (
        <>
          <p className="text-text-muted text-sm mb-3">
            Copy this token now. It will not be shown again.
          </p>
          <div className="flex gap-2 mb-4">
            <div className="flex-1 bg-bg border border-border rounded px-3 py-2 text-text font-mono text-xs select-all break-all">
              {rawToken}
            </div>
            <Button onClick={handleCopy}>
              {copied ? 'Copied!' : 'Copy'}
            </Button>
          </div>
          <div className="flex justify-end">
            <Button variant="secondary" onClick={handleClose}>
              Done
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
