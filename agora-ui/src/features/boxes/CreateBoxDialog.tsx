import { useState } from 'react';
import type { Channel } from '../../lib/contracts/server';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { boxApi, type Box, type BoxAdapter, type BoxAuth } from './api';
import { BOX_ADAPTER_OPTIONS, BOX_NAME, INPUT, TOUCH, boxError, modelProblem, parseRepos } from './boxRules';

/**
 * Create a box (docs/agent-boxes.md §9): the server creates its bot, host, profile and box row;
 * boxd then builds the container. A subscription box needs Log in next; an API key box starts
 * with the key, which is stored encrypted and given only to that box. The CLI list, its sign-in
 * modes and whether it needs a model come from BOX_ADAPTER_OPTIONS (boxRules.ts).
 */
export function CreateBoxDialog({ serverId, channels, onClose, onCreated }: {
  serverId: string; channels: Channel[]; onClose: () => void; onCreated: (box: Box) => void;
}) {
  const [name, setName] = useState('');
  const [adapter, setAdapter] = useState<BoxAdapter>('claude');
  const [auth, setAuth] = useState<BoxAuth>('subscription');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [homeChannelId, setHomeChannelId] = useState(channels[0]?.id ?? '');
  const [reposText, setReposText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const option = BOX_ADAPTER_OPTIONS.find(o => o.value === adapter) ?? BOX_ADAPTER_OPTIONS[0];
  const pickAdapter = (value: BoxAdapter) => {
    setAdapter(value);
    // Another CLI starts from its own default sign-in, and a key typed for the last one is dropped:
    // an OpenRouter key must never be sent as an Anthropic one
    const next = BOX_ADAPTER_OPTIONS.find(o => o.value === value);
    if (next) setAuth(next.auth[0]);
    setApiKey('');
  };
  const cleanModel = model.trim();
  const cleanName = name.trim().toLowerCase();
  const { repos, bad } = parseRepos(reposText);
  const problems = {
    name: !cleanName ? null : BOX_NAME.test(cleanName) ? null : 'Letters, digits, - and _; start with a letter or digit; at most 32.',
    apiKey: auth === 'api_key' && !apiKey.trim() ? 'Enter the API key.' : null,
    model: !option.model ? null : modelProblem(cleanModel),
    channel: homeChannelId ? null : 'Pick the channel the box works in.',
    repos: bad.length ? `Not owner/repo: ${bad.join(', ')}` : null,
  };
  const valid = !!cleanName && !problems.name && !problems.apiKey && !problems.model && !problems.channel && !problems.repos;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError('');
    try {
      const res = await boxApi.create(serverId, {
        name: cleanName, adapter, auth, homeChannelId,
        ...(auth === 'api_key' ? { apiKey: apiKey.trim() } : {}),
        ...(repos.length ? { repos } : {}),
        ...(option.model ? { model: cleanModel } : {}),
      });
      setApiKey('');
      onCreated(res.box);
    } catch (err) {
      setError(boxError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title="Create box">
      <form className="flex max-h-[70dvh] flex-col gap-3 overflow-y-auto text-sm" onSubmit={e => { e.preventDefault(); void submit(); }} noValidate>
        <label className="flex flex-col gap-1 text-text-muted">Name (bot and /start name)
          <input className={INPUT} value={name} maxLength={32} placeholder="builder" autoCapitalize="none" autoComplete="off"
            onChange={e => setName(e.target.value)} aria-invalid={!!problems.name} />
          {problems.name && <span className="text-xs text-danger">{problems.name}</span>}
        </label>

        <label className="flex flex-col gap-1 text-text-muted">CLI
          <select className={INPUT} value={adapter} onChange={e => pickAdapter(e.target.value as BoxAdapter)}>
            {BOX_ADAPTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>

        {option.model && (
          <label className="flex flex-col gap-1 text-text-muted">{option.model.label}
            <input className={`${INPUT} font-mono`} value={model} maxLength={64} placeholder={option.model.placeholder}
              autoCapitalize="none" autoComplete="off" spellCheck={false} onChange={e => setModel(e.target.value)} aria-invalid={!!problems.model} />
            {problems.model && <span className="text-xs text-danger">{problems.model}</span>}
          </label>
        )}

        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-text-muted">Signs in with</legend>
          {option.auth.includes('subscription') && (
            <label className="flex min-h-11 md:min-h-8 items-center gap-2 text-text">
              <input type="radio" name="box-auth" checked={auth === 'subscription'} onChange={() => setAuth('subscription')} />
              Subscription <span className="text-xs text-text-muted">your own login; only you can wake it</span>
            </label>
          )}
          {/* Devin has no API key mode: a Devin account is its holder's own */}
          {option.auth.includes('api_key') && (
            <label className="flex min-h-11 md:min-h-8 items-center gap-2 text-text">
              <input type="radio" name="box-auth" checked={auth === 'api_key'} onChange={() => setAuth('api_key')} />
              API key <span className="text-xs text-text-muted">stored encrypted, given only to this box</span>
            </label>
          )}
        </fieldset>
        {auth === 'api_key' && (
          <label className="flex flex-col gap-1 text-text-muted">{option.keyLabel}
            <input className={`${INPUT} font-mono`} type="password" value={apiKey} autoComplete="off" spellCheck={false}
              onChange={e => setApiKey(e.target.value)} aria-invalid={!!problems.apiKey} />
            {problems.apiKey && <span className="text-xs text-danger">{problems.apiKey}</span>}
          </label>
        )}

        <label className="flex flex-col gap-1 text-text-muted">Home channel (where it works and asks for approvals)
          <select className={INPUT} value={homeChannelId} onChange={e => setHomeChannelId(e.target.value)} aria-invalid={!!problems.channel}>
            {channels.length === 0 && <option value="">No channels</option>}
            {channels.map(c => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
          {problems.channel && <span className="text-xs text-danger">{problems.channel}</span>}
        </label>

        <label className="flex flex-col gap-1 text-text-muted">GitHub repositories (optional, one owner/repo per line)
          <textarea className={`${INPUT} font-mono`} rows={3} value={reposText} spellCheck={false} autoCapitalize="none"
            placeholder="octo-org/app" onChange={e => setReposText(e.target.value)} aria-invalid={!!problems.repos} />
          {problems.repos && <span className="text-xs text-danger">{problems.repos}</span>}
          <span className="text-xs">Cloned into the box through the git broker. The first one is the agent&apos;s working folder.</span>
        </label>

        {error && <p className="text-danger" role="alert">{error}</p>}
        <div className="flex flex-col-reverse gap-2 md:flex-row md:justify-end">
          <Button type="button" variant="secondary" onClick={onClose} className={TOUCH}>Cancel</Button>
          <Button type="submit" disabled={!valid} loading={busy} className={TOUCH}>Create box</Button>
        </div>
      </form>
    </Modal>
  );
}
