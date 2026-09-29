import { useState } from 'react';
import { aiApi, botApi, ApiError } from '../../../lib/api';
import type { AIConfig } from '../../../lib/api';
import type { Channel } from '../../../lib/contracts/server';
import { Button } from '../../../components/ui/Button';
import { inputClass } from './format';

interface Props {
  serverId: string;
  config: AIConfig;
  hasChatRoute: boolean;
  channels: Channel[];
  botChannelIds: Set<string>;
  onChanged: () => void;
}

export function AssistantSection({ serverId, config, hasChatRoute, channels, botChannelIds, onChanged }: Props) {
  const [systemPrompt, setSystemPrompt] = useState(config.systemPrompt ?? '');
  const [maxContext, setMaxContext] = useState(config.maxContext ?? 20);
  const [access, setAccess] = useState(botChannelIds);
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const fail = (err: unknown, fallback: string) => setError(err instanceof ApiError ? err.code : fallback);

  if (!config.configured || !config.botId) {
    return (
      <section className="mb-10">
        <h3 className="text-lg font-semibold text-text mb-2">Built-in assistant</h3>
        <p className="text-sm text-text-muted mb-3">
          A bot members can @mention in channels and threads. It answers using the Chat capability above.
        </p>
        {!hasChatRoute && <p className="text-warn text-sm mb-3">Set up the Chat capability first so it has something to answer with.</p>}
        {error && <p className="text-danger text-sm mb-3">{error}</p>}
        <Button
          loading={creating}
          onClick={async () => {
            setCreating(true);
            setError('');
            try {
              await aiApi.createAssistant(serverId);
              onChanged();
            } catch (err) {
              fail(err, 'Failed to create assistant');
              setCreating(false);
            }
          }}
        >
          Create assistant bot
        </Button>
      </section>
    );
  }

  const botId = config.botId;

  async function save() {
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      await aiApi.patchConfig(serverId, { systemPrompt: systemPrompt.trim() || null, maxContext });
      setSaved(true);
    } catch (err) {
      fail(err, 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  async function toggleEnabled() {
    try {
      await aiApi.patchConfig(serverId, { enabled: !config.enabled });
      onChanged();
    } catch (err) {
      fail(err, 'Failed to update');
    }
  }

  async function toggleChannel(channelId: string) {
    const has = access.has(channelId);
    try {
      if (has) await botApi.revokeChannel(channelId, botId);
      else await botApi.grantChannel(channelId, botId);
      setAccess(prev => {
        const next = new Set(prev);
        if (has) next.delete(channelId); else next.add(channelId);
        return next;
      });
    } catch (err) {
      fail(err, 'Failed to update channel access');
    }
  }

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-text">Built-in assistant</h3>
        <Button variant={config.enabled ? 'danger' : 'secondary'} onClick={toggleEnabled}>
          {config.enabled ? 'Disable' : 'Enable'}
        </Button>
      </div>
      <p className="text-sm text-text-muted mb-4">
        Answers @mentions using the Chat capability
        {config.model ? <> (currently <span className="text-text">{config.model}</span>)</> : null}.
        {!hasChatRoute && <span className="text-warn"> No Chat capability is set, so it won't reply.</span>}
      </p>

      <label className="text-sm text-text-muted block mb-1" htmlFor="ai-system-prompt">System prompt</label>
      <textarea
        id="ai-system-prompt"
        value={systemPrompt}
        onChange={e => { setSystemPrompt(e.target.value); setSaved(false); }}
        placeholder="Optional instructions for the assistant..."
        rows={4}
        className={`w-full resize-y ${inputClass}`}
      />

      <label className="text-sm text-text-muted block mt-4 mb-1" htmlFor="ai-context">
        Context messages: {maxContext}
      </label>
      <input
        id="ai-context"
        type="range"
        min={1}
        max={100}
        value={maxContext}
        onChange={e => { setMaxContext(parseInt(e.target.value, 10)); setSaved(false); }}
        className="w-full"
      />
      <p className="text-xs text-text-dim mt-1">Recent messages (or thread replies) sent as context with each mention.</p>

      <div className="flex items-center gap-3 mt-4">
        <Button onClick={save} loading={saving}>Save</Button>
        {saved && <span className="text-sm text-online">Saved</span>}
      </div>

      <h4 className="text-sm font-semibold text-text mt-6 mb-2">Channels it can answer in</h4>
      <div className="space-y-1 max-h-60 overflow-y-auto">
        {channels.map(ch => (
          <label key={ch.id} className="flex items-center gap-2 px-3 py-1.5 rounded hover:bg-surface-hover cursor-pointer">
            <input type="checkbox" checked={access.has(ch.id)} onChange={() => toggleChannel(ch.id)} className="accent-primary" />
            <span className="text-text text-sm">#{ch.name}</span>
          </label>
        ))}
        {channels.length === 0 && <p className="text-text-dim text-sm">No text channels found.</p>}
      </div>
      {error && <p className="text-danger text-sm mt-3">{error}</p>}
    </section>
  );
}
