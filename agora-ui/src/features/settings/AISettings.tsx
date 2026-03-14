import { useEffect, useState, useCallback } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { aiApi, botApi, serverApi, ApiError } from '../../lib/api';
import type { AIConfig, AIUsageStats } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';

export function AISettings() {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);

  // Form state
  const [provider, setProvider] = useState<'claude' | 'openai'>('claude');
  const [model, setModel] = useState('claude-sonnet-4-20250514');
  const [apiKey, setApiKey] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [maxContext, setMaxContext] = useState(20);
  const [enabled, setEnabled] = useState(true);
  const [configured, setConfigured] = useState(false);
  const [botId, setBotId] = useState<string | null>(null);

  // Channel access state
  const [channels, setChannels] = useState<Channel[]>([]);
  const [botChannelIds, setBotChannelIds] = useState<Set<string>>(new Set());

  // Usage state
  const [usage, setUsage] = useState<AIUsageStats | null>(null);

  const loadConfig = useCallback(async () => {
    if (!instanceServerId) return;
    setLoading(true);
    try {
      const cfg = await aiApi.getConfig(instanceServerId);
      if (cfg.configured) {
        setConfigured(true);
        setProvider((cfg.provider as 'claude' | 'openai') || 'claude');
        setModel(cfg.model || '');
        setSystemPrompt(cfg.systemPrompt || '');
        setMaxContext(cfg.maxContext || 20);
        setEnabled(cfg.enabled ?? true);
        setBotId(cfg.botId || null);
      }

      // Load channels for access management
      const chs = await serverApi.getChannels(instanceServerId);
      setChannels(chs.filter(c => c.channelType === 3)); // server text channels only

      // Load bot channel access if bot exists
      if (cfg.configured && cfg.botId) {
        try {
          const bot = await botApi.get(instanceServerId, cfg.botId);
          setBotChannelIds(new Set(bot.channels.map(c => c.id)));
        } catch { /* bot may not exist yet */ }
      }

      // Load usage stats
      try {
        const u = await aiApi.getUsage(instanceServerId);
        setUsage(u);
      } catch { /* no usage yet */ }
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, [instanceServerId]);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const handleTest = useCallback(async () => {
    if (!instanceServerId || !apiKey) return;
    setTesting(true);
    setTestResult(null);
    try {
      const result = await aiApi.testConnection(instanceServerId, { provider, model, apiKey });
      setTestResult(result);
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof ApiError ? err.code : 'Test failed' });
    } finally {
      setTesting(false);
    }
  }, [instanceServerId, provider, model, apiKey]);

  const handleSave = useCallback(async () => {
    if (!instanceServerId || !apiKey) return;
    setSaving(true);
    setError('');
    try {
      const result = await aiApi.updateConfig(instanceServerId, {
        provider, model, apiKey, systemPrompt: systemPrompt || null, maxContext,
      });
      setConfigured(true);
      setBotId(result.botId || null);
      setApiKey(''); // Clear after save for security
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }, [instanceServerId, provider, model, apiKey, systemPrompt, maxContext]);

  const handleToggle = useCallback(async () => {
    if (!instanceServerId) return;
    try {
      const result = await aiApi.patchConfig(instanceServerId, { enabled: !enabled });
      setEnabled(result.enabled);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to toggle');
    }
  }, [instanceServerId, enabled]);

  const toggleChannelAccess = useCallback(async (channelId: string) => {
    if (!instanceServerId || !botId) return;
    const has = botChannelIds.has(channelId);
    try {
      if (has) {
        await botApi.revokeChannel(channelId, botId);
        setBotChannelIds(prev => { const next = new Set(prev); next.delete(channelId); return next; });
      } else {
        await botApi.grantChannel(channelId, botId);
        setBotChannelIds(prev => new Set(prev).add(channelId));
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to update channel access');
    }
  }, [instanceServerId, botId, botChannelIds]);

  if (!instanceServerId) return null;

  if (loading) {
    return (
      <div>
        <h2 className="text-xl font-bold text-text mb-4">AI Assistant</h2>
        <p className="text-text-muted">Loading...</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold text-text mb-6">AI Assistant</h2>

      {error && <p className="text-danger text-sm mb-4">{error}</p>}

      {/* Provider & Model */}
      <div className="space-y-4 mb-6">
        <div className="flex flex-col gap-1">
          <label className="text-sm text-text-muted">Provider</label>
          <select
            value={provider}
            onChange={e => {
              const p = e.target.value as 'claude' | 'openai';
              setProvider(p);
              setModel(p === 'claude' ? 'claude-sonnet-4-20250514' : 'gpt-4o');
            }}
            className="bg-surface border border-border rounded px-3 py-2 text-text focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <option value="claude">Claude (Anthropic)</option>
            <option value="openai">OpenAI</option>
          </select>
        </div>

        <Input
          label="Model"
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder={provider === 'claude' ? 'claude-sonnet-4-20250514' : 'gpt-4o'}
        />

        <Input
          label="API Key"
          type="password"
          value={apiKey}
          onChange={e => setApiKey(e.target.value)}
          placeholder={configured ? '(saved — enter new key to update)' : 'Enter API key'}
        />

        <div className="flex gap-2">
          <Button
            variant="secondary"
            onClick={handleTest}
            loading={testing}
            disabled={!apiKey}
          >
            Test Connection
          </Button>
          {testResult && (
            <span className={`self-center text-sm ${testResult.ok ? 'text-green-400' : 'text-danger'}`}>
              {testResult.ok ? 'Connection successful' : testResult.error || 'Connection failed'}
            </span>
          )}
        </div>
      </div>

      {/* System Prompt */}
      <div className="mb-6">
        <label className="text-sm text-text-muted block mb-1">System Prompt</label>
        <textarea
          value={systemPrompt}
          onChange={e => setSystemPrompt(e.target.value)}
          placeholder="Optional system instructions for the AI assistant..."
          rows={4}
          className="w-full bg-surface border border-border rounded px-3 py-2 text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary resize-y"
        />
      </div>

      {/* Max Context */}
      <div className="mb-6">
        <label className="text-sm text-text-muted block mb-1">
          Context Messages: {maxContext}
        </label>
        <input
          type="range"
          min={1}
          max={100}
          value={maxContext}
          onChange={e => setMaxContext(parseInt(e.target.value))}
          className="w-full"
        />
        <p className="text-xs text-text-dim mt-1">
          Number of recent messages included as conversation context
        </p>
      </div>

      {/* Save */}
      <div className="flex items-center gap-4 mb-8">
        <Button onClick={handleSave} loading={saving} disabled={!apiKey && !configured}>
          {configured ? 'Update Configuration' : 'Save & Create Bot'}
        </Button>

        {configured && (
          <Button
            variant={enabled ? 'danger' : 'secondary'}
            onClick={handleToggle}
          >
            {enabled ? 'Disable' : 'Enable'}
          </Button>
        )}
      </div>

      {/* Channel Access */}
      {configured && botId && (
        <div className="mb-8">
          <h3 className="text-lg font-semibold text-text mb-3">Channel Access</h3>
          <p className="text-sm text-text-muted mb-3">
            Select which channels the AI assistant can respond in.
          </p>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {channels.map(ch => (
              <label key={ch.id} className="flex items-center gap-2 px-3 py-2 rounded hover:bg-surface-hover cursor-pointer">
                <input
                  type="checkbox"
                  checked={botChannelIds.has(ch.id)}
                  onChange={() => toggleChannelAccess(ch.id)}
                  className="accent-primary"
                />
                <span className="text-text text-sm">#{ch.name}</span>
              </label>
            ))}
            {channels.length === 0 && (
              <p className="text-text-dim text-sm">No text channels found.</p>
            )}
          </div>
        </div>
      )}

      {/* Usage Stats */}
      {configured && usage && (
        <div>
          <h3 className="text-lg font-semibold text-text mb-3">Usage (Last 30 Days)</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-surface border border-border rounded p-3">
              <p className="text-text-muted text-xs">Total Requests</p>
              <p className="text-text text-lg font-semibold">{usage.total_requests}</p>
            </div>
            <div className="bg-surface border border-border rounded p-3">
              <p className="text-text-muted text-xs">Input Tokens</p>
              <p className="text-text text-lg font-semibold">{usage.total_input_tokens.toLocaleString()}</p>
            </div>
            <div className="bg-surface border border-border rounded p-3">
              <p className="text-text-muted text-xs">Output Tokens</p>
              <p className="text-text text-lg font-semibold">{usage.total_output_tokens.toLocaleString()}</p>
            </div>
            <div className="bg-surface border border-border rounded p-3">
              <p className="text-text-muted text-xs">Avg Latency</p>
              <p className="text-text text-lg font-semibold">{usage.avg_latency_ms}ms</p>
            </div>
            {usage.error_count > 0 && (
              <div className="bg-surface border border-danger/50 rounded p-3">
                <p className="text-text-muted text-xs">Errors</p>
                <p className="text-danger text-lg font-semibold">{usage.error_count}</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
