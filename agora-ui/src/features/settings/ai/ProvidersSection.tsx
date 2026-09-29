import { useState } from 'react';
import { aiApi, ApiError } from '../../../lib/api';
import type { AIAdapter, AIProvider, AIConnectionResult } from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { CAPABILITY_INFO, inputClass } from './format';

interface Props {
  serverId: string;
  adapters: AIAdapter[];
  providers: AIProvider[];
  /** Model to test each provider with (its chat route model, if any). */
  testModels: Record<string, string>;
  isInstanceAdmin: boolean;
  allowPrivateBaseUrls: boolean | null;
  onChanged: () => void;
  onAllowPrivateChanged: (value: boolean) => void;
}

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (err.message || err.code) : fallback;

export function ProvidersSection({
  serverId, adapters, providers, testModels, isInstanceAdmin, allowPrivateBaseUrls, onChanged, onAllowPrivateChanged,
}: Props) {
  const [adding, setAdding] = useState(false);

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-text">Providers</h3>
        {!adding && <Button variant="secondary" onClick={() => setAdding(true)}>Add provider</Button>}
      </div>
      <p className="text-sm text-text-muted mb-4">
        API accounts Agora can call. Add as many as you like. Each capability below picks one.
      </p>

      {adding && (
        <AddProviderForm
          serverId={serverId}
          adapters={adapters}
          onCancel={() => setAdding(false)}
          onCreated={() => { setAdding(false); onChanged(); }}
        />
      )}

      {providers.length === 0 && !adding ? (
        <p className="text-text-dim text-sm">No providers yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {providers.map(p => (
            <ProviderRow
              key={p.id}
              serverId={serverId}
              provider={p}
              adapter={adapters.find(a => a.id === p.adapter)}
              testModel={testModels[p.id]}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}

      {isInstanceAdmin && allowPrivateBaseUrls !== null && (
        <label className="flex items-start gap-2 mt-4 text-sm text-text-muted cursor-pointer">
          <input
            type="checkbox"
            className="accent-primary mt-0.5"
            checked={allowPrivateBaseUrls}
            onChange={e => onAllowPrivateChanged(e.target.checked)}
          />
          <span>
            <span className="text-text">Allow private network base URLs</span> (instance-wide). Needed for local
            servers like Ollama; lets server admins point Agora at addresses on your internal network.
          </span>
        </label>
      )}
    </section>
  );
}

function AddProviderForm({ serverId, adapters, onCancel, onCreated }: {
  serverId: string;
  adapters: AIAdapter[];
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [adapterId, setAdapterId] = useState(adapters[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const adapter = adapters.find(a => a.id === adapterId);

  async function save() {
    if (!adapter) return;
    if (adapter.requiresApiKey && !apiKey) { setError(`${adapter.label} requires an API key`); return; }
    setSaving(true);
    setError('');
    try {
      await aiApi.createProvider(serverId, {
        adapter: adapter.id,
        ...(label.trim() ? { label: label.trim() } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(adapter.supportsBaseUrl && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      });
      onCreated();
    } catch (err) {
      setError(errorText(err, 'Failed to add provider'));
      setSaving(false);
    }
  }

  return (
    <div className="border border-border rounded-lg p-4 mb-4 space-y-3">
      <div className="flex flex-col gap-1">
        <label className="text-sm text-text-muted" htmlFor="ai-adapter">Type</label>
        <select id="ai-adapter" className={inputClass} value={adapterId} onChange={e => setAdapterId(e.target.value)}>
          {adapters.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}
        </select>
      </div>
      <Input label="Label" value={label} onChange={e => setLabel(e.target.value)} placeholder={adapter?.label ?? ''} />
      <Input
        label={adapter?.requiresApiKey ? 'API key' : 'API key (optional)'}
        type="password"
        autoComplete="off"
        value={apiKey}
        onChange={e => setApiKey(e.target.value)}
      />
      {adapter?.supportsBaseUrl && (
        <div>
          <Input
            label="Base URL (optional)"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder={adapter.defaultBaseUrl}
          />
          <p className="text-xs text-text-dim mt-1">
            Any OpenAI-compatible server, e.g. Ollama at <code>http://localhost:11434/v1</code>, OpenRouter, Groq, vLLM.
          </p>
        </div>
      )}
      {error && <p className="text-danger text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={save} loading={saving}>Add</Button>
        <Button variant="secondary" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function ProviderRow({ serverId, provider, adapter, testModel, onChanged }: {
  serverId: string;
  provider: AIProvider;
  adapter?: AIAdapter;
  testModel?: string;
  onChanged: () => void;
}) {
  const [model, setModel] = useState(testModel ?? adapter?.defaultModels.chat ?? '');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AIConnectionResult | null>(null);
  const [newKey, setNewKey] = useState('');
  const [editingKey, setEditingKey] = useState(false);
  const [error, setError] = useState('');

  async function run(action: () => Promise<unknown>, fallback: string) {
    setError('');
    try {
      await action();
      onChanged();
    } catch (err) {
      setError(errorText(err, fallback));
    }
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      setResult(await aiApi.testProvider(serverId, provider.id, model.trim() || undefined));
    } catch (err) {
      setResult({ ok: false, error: errorText(err, 'Test failed') });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className={`border border-border rounded-lg p-3 ${provider.enabled ? '' : 'opacity-60'}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-text font-medium">{provider.label}</span>
        <span className="text-xs text-text-dim">{adapter?.label ?? provider.adapter}</span>
        {provider.capabilities.map(c => (
          <span key={c} className="px-1.5 py-0.5 rounded text-[10px] font-semibold leading-none bg-primary/20 text-primary">
            {CAPABILITY_INFO[c].label}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-3 text-xs">
          <span className={provider.hasApiKey ? 'text-online' : 'text-text-dim'}>
            {provider.hasApiKey ? 'Key saved' : 'No key'}
          </span>
          <label className="flex items-center gap-1 text-text-muted cursor-pointer">
            <input
              type="checkbox"
              className="accent-primary"
              checked={provider.enabled}
              onChange={e => run(() => aiApi.updateProvider(serverId, provider.id, { enabled: e.target.checked }), 'Failed to update')}
            />
            Enabled
          </label>
        </span>
      </div>
      {provider.baseUrl && <p className="text-xs text-text-dim mt-1 break-all">{provider.baseUrl}</p>}

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <input
          className={`${inputClass} py-1 text-sm w-56`}
          value={model}
          onChange={e => setModel(e.target.value)}
          placeholder="model to test"
          aria-label={`Test model for ${provider.label}`}
        />
        <Button variant="secondary" onClick={test} loading={testing} disabled={!model.trim()}>Test</Button>
        <Button variant="secondary" onClick={() => setEditingKey(v => !v)}>
          {provider.hasApiKey ? 'Replace key' : 'Add key'}
        </Button>
        <Button
          variant="danger"
          onClick={() => {
            const routes = provider.capabilities.length
              ? `\n\nIt currently serves: ${provider.capabilities.map(c => CAPABILITY_INFO[c].label).join(', ')}. Those routes will be removed.`
              : '';
            if (confirm(`Delete provider "${provider.label}"?${routes}`)) {
              run(() => aiApi.deleteProvider(serverId, provider.id), 'Failed to delete');
            }
          }}
        >
          Delete
        </Button>
        {result && (
          <span className={`text-sm ${result.ok ? 'text-online' : 'text-danger'} break-all`}>
            {result.ok ? 'Connection OK' : result.error || 'Connection failed'}
          </span>
        )}
      </div>

      {editingKey && (
        <div className="flex items-center gap-2 mt-2">
          <input
            className={`${inputClass} py-1 text-sm flex-1`}
            type="password"
            autoComplete="off"
            value={newKey}
            onChange={e => setNewKey(e.target.value)}
            placeholder="New API key"
            aria-label={`New API key for ${provider.label}`}
          />
          <Button
            onClick={() => run(async () => {
              await aiApi.updateProvider(serverId, provider.id, { apiKey: newKey });
              setNewKey('');
              setEditingKey(false);
            }, 'Failed to save key')}
            disabled={!newKey}
          >
            Save key
          </Button>
        </div>
      )}
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </div>
  );
}
