import { useState } from 'react';
import { aiApi, ApiError } from '../../../lib/api';
import type { AIAdapter, AICapability, AIProvider, AIRoute } from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import {
  CAPABILITY_INFO, CAPABILITY_ORDER, dollarsToMicros, inputClass, microsToDollars, parseLimit,
} from './format';

interface Props {
  serverId: string;
  adapters: AIAdapter[];
  providers: AIProvider[];
  routes: AIRoute[];
  onChanged: () => void;
}

export function RoutesSection({ serverId, adapters, providers, routes, onChanged }: Props) {
  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold text-text mb-2">Capabilities</h3>
      <p className="text-sm text-text-muted mb-4">
        Choose which provider and model handles each job. Anything beyond chat starts off, so it only costs
        money once you turn it on. Daily limits reset at midnight UTC.
      </p>
      <div className="flex flex-col gap-2">
        {CAPABILITY_ORDER.map(capability => {
          const eligible = providers.filter(p =>
            adapters.find(a => a.id === p.adapter)?.capabilities.includes(capability));
          return (
            <RouteRow
              // Re-mount (re-seed form state) when the saved route or the eligible providers change
              key={`${capability}:${routes.find(r => r.capability === capability)?.updatedAt ?? 'none'}:${eligible.map(p => p.id).join(',')}`}
              serverId={serverId}
              capability={capability}
              route={routes.find(r => r.capability === capability)}
              eligible={eligible}
              adapters={adapters}
              onChanged={onChanged}
            />
          );
        })}
      </div>
    </section>
  );
}

function RouteRow({ serverId, capability, route, eligible, adapters, onChanged }: {
  serverId: string;
  capability: AICapability;
  route?: AIRoute;
  eligible: AIProvider[];
  adapters: AIAdapter[];
  onChanged: () => void;
}) {
  const info = CAPABILITY_INFO[capability];
  const adapterOf = (id: string) => adapters.find(a => a.id === eligible.find(p => p.id === id)?.adapter);
  const defaultModel = (id: string) => adapterOf(id)?.defaultModels[capability] ?? '';
  const choicesFor = (id: string) => adapterOf(id)?.modelChoices?.[capability];

  const initialProvider = route?.providerId ?? eligible[0]?.id ?? '';
  const initialChoices = choicesFor(initialProvider);
  // A saved value outside the adapter's fixed choices (e.g. an LLM name left on a Tavily route) can't work
  const savedModelInvalid = !!(route && initialChoices && !initialChoices.includes(route.model));

  const [providerId, setProviderId] = useState(initialProvider);
  const [model, setModel] = useState(
    route?.model && !savedModelInvalid ? route.model : defaultModel(initialProvider),
  );
  const choices = choicesFor(providerId);
  const [enabled, setEnabled] = useState(route?.enabled ?? capability === 'chat');
  const [showLimits, setShowLimits] = useState(false);
  const [requests, setRequests] = useState(route?.dailyRequestLimit?.toString() ?? '');
  const [tokens, setTokens] = useState(route?.dailyTokenLimit?.toString() ?? '');
  const [costLimit, setCostLimit] = useState(microsToDollars(route?.dailyCostLimitMicros ?? null));
  const [inPrice, setInPrice] = useState(microsToDollars(route?.inputPriceMicrosPerMtok ?? null));
  const [outPrice, setOutPrice] = useState(microsToDollars(route?.outputPriceMicrosPerMtok ?? null));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  if (eligible.length === 0) {
    return (
      <div className="border border-border rounded-lg px-4 py-3 flex items-center gap-3">
        <CapabilityName label={info.label} description={info.description} />
        <span className="ml-auto text-xs text-text-dim">No configured provider supports this yet</span>
      </div>
    );
  }

  async function save() {
    const limits = {
      dailyRequestLimit: parseLimit(requests),
      dailyTokenLimit: parseLimit(tokens),
      dailyCostLimitMicros: dollarsToMicros(costLimit),
      inputPriceMicrosPerMtok: dollarsToMicros(inPrice),
      outputPriceMicrosPerMtok: dollarsToMicros(outPrice),
    };
    if (Object.values(limits).some(v => v === undefined)) {
      setError('Limits must be positive whole numbers; prices must be non-negative dollar amounts.');
      return;
    }
    if (limits.dailyCostLimitMicros === 0) {
      setError('Daily cost limit must be greater than $0 (leave blank for no limit).');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const value = choices && !choices.includes(model) ? choices[0] : model.trim();
      await aiApi.putRoute(serverId, capability, {
        providerId, model: value, enabled, ...(limits as Record<string, number | null>),
      });
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message || err.code) : 'Failed to save');
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await aiApi.deleteRoute(serverId, capability);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : 'Failed to remove');
    }
  }

  const limitsSummary = [
    route?.dailyRequestLimit ? `${route.dailyRequestLimit} req/day` : null,
    route?.dailyTokenLimit ? `${route.dailyTokenLimit.toLocaleString()} tokens/day` : null,
    route?.dailyCostLimitMicros ? `$${microsToDollars(route.dailyCostLimitMicros)}/day` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="border border-border rounded-lg px-4 py-3">
      <div className="flex items-center gap-3 flex-wrap">
        <CapabilityName label={info.label} description={info.description} />
        {!route && <span className="text-xs text-text-dim">Not set</span>}
        {savedModelInvalid && (
          <span className="text-xs text-danger">Saved model “{route!.model}” isn’t valid here; pick one and save</span>
        )}
        {route && !route.enabled && <span className="text-xs text-warn">Off</span>}
        {limitsSummary && <span className="text-xs text-text-dim">{limitsSummary}</span>}
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        <select
          className={`${inputClass} py-1 text-sm`}
          value={providerId}
          aria-label={`${info.label} provider`}
          onChange={e => {
            const next = e.target.value;
            // A different provider type means different model names: start from its default
            if (!model.trim() || adapterOf(next)?.id !== adapterOf(providerId)?.id) setModel(defaultModel(next));
            setProviderId(next);
          }}
        >
          {eligible.map(p => <option key={p.id} value={p.id}>{p.label}{p.enabled ? '' : ' (disabled)'}</option>)}
        </select>
        {choices ? (
          <select
            className={`${inputClass} py-1 text-sm w-56`}
            value={choices.includes(model) ? model : choices[0]}
            onChange={e => setModel(e.target.value)}
            aria-label={`${info.label} model`}
          >
            {choices.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        ) : (
          <input
            className={`${inputClass} py-1 text-sm w-56`}
            value={model}
            onChange={e => setModel(e.target.value)}
            placeholder="model"
            aria-label={`${info.label} model`}
          />
        )}
        <label className="flex items-center gap-1 text-sm text-text-muted cursor-pointer">
          <input type="checkbox" className="accent-primary" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
          On
        </label>
        <button className="text-sm text-primary hover:underline" onClick={() => setShowLimits(v => !v)}>
          {showLimits ? 'Hide limits' : 'Limits & prices'}
        </button>
        <span className="ml-auto flex gap-2">
          <Button onClick={save} loading={saving} disabled={!providerId || !model.trim()}>Save</Button>
          {route && <Button variant="secondary" onClick={remove}>Remove</Button>}
        </span>
      </div>

      {showLimits && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
          <LimitInput label="Requests / day" value={requests} onChange={setRequests} placeholder="unlimited" />
          <LimitInput label="Tokens / day" value={tokens} onChange={setTokens} placeholder="unlimited" />
          <LimitInput label="Cost / day ($)" value={costLimit} onChange={setCostLimit} placeholder="unlimited" />
          <LimitInput label="Input price ($ / 1M tokens)" value={inPrice} onChange={setInPrice} placeholder="not tracked" />
          <LimitInput label="Output price ($ / 1M tokens)" value={outPrice} onChange={setOutPrice} placeholder="not tracked" />
          <p className="text-xs text-text-dim sm:col-span-3">
            Prices are only used to estimate cost; enter them from your provider's pricing page. The cost limit
            needs prices to take effect.
          </p>
        </div>
      )}
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </div>
  );
}

function CapabilityName({ label, description }: { label: string; description: string }) {
  return (
    <div>
      <span className="text-text font-medium">{label}</span>
      <span className="text-xs text-text-dim ml-2">{description}</span>
    </div>
  );
}

function LimitInput({ label, value, onChange, placeholder }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-text-muted">
      {label}
      <input
        className={`${inputClass} py-1 text-sm`}
        inputMode="decimal"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
