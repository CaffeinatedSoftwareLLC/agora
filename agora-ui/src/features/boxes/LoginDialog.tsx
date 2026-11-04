import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../../lib/api';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { boxApi, type Box, type BoxLogin } from './api';
import { ADAPTER_LABEL, INPUT, TOUCH, boxError, loginEnded, loginStatusText, safeUrl } from './boxRules';

/**
 * Logging a box's CLI in (docs/agent-boxes.md §8.2). Agora records a login request, the box's
 * agora-host runs the CLI's own login and reports what it printed: Codex a verification URL and
 * a one-time code, Claude Code a sign-in URL and then a code to paste back. The dialog polls the
 * request until it ends; Cancel (or closing the dialog) cancels it on the server.
 */
export function LoginDialog({ box, onClose, pollMs = 2000 }: { box: Box; onClose: (changed: boolean) => void; pollMs?: number }) {
  const [login, setLogin] = useState<BoxLogin | null>(null);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [copied, setCopied] = useState(false);
  const [closing, setClosing] = useState(false);
  const loginRef = useRef<BoxLogin | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (l: BoxLogin | null) => { loginRef.current = l; setLogin(l); };
    const poll = async () => {
      try {
        const res = await boxApi.getLogin(box.id);
        if (!live) return;
        show(res.login);
        if (!res.login || loginEnded(res.login.status)) return;
      } catch (err) {
        if (!live) return;
        setError(boxError(err));
      }
      if (live) timer = setTimeout(() => void poll(), pollMs);
    };
    boxApi.startLogin(box.id).then(
      res => { if (!live) return; show(res.login); timer = setTimeout(() => void poll(), pollMs); },
      // A login already running (another tab, or a re-mounted dialog) is the one to follow
      err => {
        if (!live) return;
        if (err instanceof ApiError && err.code === 'login_active') void poll();
        else setError(boxError(err));
      },
    );
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [box.id, pollMs]);

  const ended = !!login && loginEnded(login.status);
  const url = safeUrl(login?.verificationUrl);
  const wantsCode = box.adapter === 'claude' && !sent && (login?.status === 'awaiting_code' || login?.status === 'awaiting_user');

  const close = async () => {
    const current = loginRef.current;
    if (current && !loginEnded(current.status)) {
      setClosing(true);
      // The URL and codes are deleted on the server when the login ends
      try { await boxApi.cancelLogin(box.id); } catch { /* it may have ended meanwhile */ }
    }
    onClose(!!current);
  };

  const sendCode = async () => {
    const c = code.trim();
    if (!c) return;
    setSending(true);
    setError('');
    try {
      await boxApi.sendLoginCode(box.id, c);
      setSent(true);
      setCode('');
    } catch (err) {
      setError(boxError(err));
    } finally {
      setSending(false);
    }
  };

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
  };

  const tone = login?.status === 'succeeded' ? 'text-online' : login?.status === 'failed' || login?.status === 'expired' ? 'text-danger' : 'text-text';

  return (
    <Modal isOpen onClose={() => void close()} title={`Log in ${ADAPTER_LABEL[box.adapter] ?? box.adapter} in ${box.name}`}>
      <div className="flex max-h-[70dvh] flex-col gap-3 overflow-y-auto text-sm">
        <p className={tone} role="status" data-testid="login-status">{loginStatusText(login, box.adapter)}</p>

        {!ended && url && (
          <a href={url} target="_blank" rel="noopener noreferrer" className="break-all rounded border border-border bg-bg px-3 py-2 text-primary underline">
            {url}
          </a>
        )}
        {!ended && login?.verificationUrl && !url && (
          <code className="break-all rounded bg-bg p-2 font-mono text-xs text-text">{login.verificationUrl}</code>
        )}

        {!ended && login?.userCode && (
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all rounded bg-bg px-3 py-2 text-center font-mono text-lg tracking-widest text-text" aria-label="One-time code">
              {login.userCode}
            </code>
            <Button variant="secondary" onClick={() => copy(login.userCode!)}>{copied ? 'Copied' : 'Copy code'}</Button>
          </div>
        )}

        {wantsCode && (
          <form className="flex flex-col gap-2 md:flex-row" onSubmit={e => { e.preventDefault(); void sendCode(); }}>
            <input className={`${INPUT} font-mono`} value={code} onChange={e => setCode(e.target.value)} autoComplete="off" spellCheck={false}
              placeholder="Paste the code Anthropic shows" aria-label="Code from Anthropic" maxLength={500} />
            <Button type="submit" disabled={!code.trim()} loading={sending} className={TOUCH}>Send code</Button>
          </form>
        )}

        {!ended && (
          <p className="text-xs text-text-muted">
            The link and codes pass through Agora only while this login runs and are deleted when it ends. The login itself is saved only in the box&apos;s home folder.
          </p>
        )}
        {error && <p className="text-danger" role="alert">{error}</p>}

        <div className="flex justify-end gap-2">
          {ended || (!login && error)
            ? <Button onClick={() => onClose(true)} className={TOUCH}>Close</Button>
            : <Button variant="secondary" onClick={() => void close()} loading={closing} className={TOUCH}>Cancel</Button>}
        </div>
      </div>
    </Modal>
  );
}
