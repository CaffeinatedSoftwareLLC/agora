import { useState } from 'react';
import { aiApi, ApiError, MODEL_AGENT_TOOLS } from '../../../lib/api';
import type { AIAdapter, AIProvider, ModelAgent, ModelAgentBudget, ModelAgentTool } from '../../../lib/api';
import type { Channel } from '../../../lib/contracts/server';
import { Button } from '../../../components/ui/Button';
import { Input } from '../../../components/ui/Input';
import { formatMicros, inputClass } from './format';

interface Props {
  serverId: string;
  adapters: AIAdapter[];
  providers: AIProvider[];
  agents: ModelAgent[];
  budget: ModelAgentBudget;
  channels: Channel[];
  onChanged: () => void;
}

const TOOL_INFO: Record<ModelAgentTool, string> = {
  read_history: 'Read channel and thread history',
  post_message: 'Post extra messages and thread replies',
  file_search: 'Search shared files',
  file_read: 'Read shared files',
  task_list: 'List task cards',
  task_create: 'Create task cards (needs direct permission in the channel)',
  task_update: 'Update task cards (needs direct permission in the channel)',
  canvas_publish: 'Publish to the canvas',
  runtime_exec: 'Run code in the sandbox (each run needs approval)',
};

const NAME = /^[A-Za-z0-9_-]{1,32}$/;

const errorText = (err: unknown, fallback: string) =>
  err instanceof ApiError ? (err.message || err.code) : fallback;

/**
 * Settings → AI → Model agents: named bots with their own provider and model that
 * answer @mentions on the server and can use tools (docs/model-agents.md).
 */
export function AgentsSection({ serverId, adapters, providers, agents, budget, channels, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  // Only adapters that implement function calling can serve an agent; today that is the OpenAI-compatible one
  const usable = providers.filter(p => p.enabled && p.adapter === 'openai');

  return (
    <section className="mb-10">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-lg font-semibold text-text">Model agents</h3>
        {!adding && <Button variant="secondary" onClick={() => setAdding(true)} disabled={usable.length === 0}>Add agent</Button>}
      </div>
      <p className="text-sm text-text-muted mb-4">
        Bots that run on this server with their own model, for example an OpenRouter model. @mention one in a channel it was
        added to. Only messages from the owner and directors count as instructions; everyone else gets answers, not actions.
      </p>
      {usable.length === 0 && (
        <p className="text-warn text-sm mb-3">
          Add an OpenAI-compatible provider first (OpenAI, or OpenRouter with base URL https://openrouter.ai/api/v1).
        </p>
      )}

      <BudgetControl key={JSON.stringify({ ...budget, today: undefined })} serverId={serverId} budget={budget} onChanged={onChanged} />

      {adding && (
        <AgentForm
          serverId={serverId}
          providers={usable}
          adapters={adapters}
          channels={channels}
          onCancel={() => setAdding(false)}
          onSaved={() => { setAdding(false); onChanged(); }}
        />
      )}

      {agents.length === 0 && !adding ? (
        <p className="text-text-muted text-sm">No model agents yet.</p>
      ) : (
        <div className="flex flex-col gap-2">
          {agents.map(a => (
            <AgentRow key={a.id} serverId={serverId} agent={a} providers={usable} adapters={adapters} channels={channels} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}

/** Shared with @assistant on the Chat route (the default), or a separate daily pool for all agents. */
function BudgetControl({ serverId, budget, onChanged }: { serverId: string; budget: ModelAgentBudget; onChanged: () => void }) {
  const [mode, setMode] = useState(budget.mode);
  const [requests, setRequests] = useState(budget.dailyRequestLimit?.toString() ?? '');
  const [tokens, setTokens] = useState(budget.dailyTokenLimit?.toString() ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function save() {
    setSaving(true);
    setError('');
    try {
      await aiApi.updateAgentBudget(serverId, {
        mode,
        ...(mode === 'separate' ? { dailyRequestLimit: optionalInt(requests) || null, dailyTokenLimit: optionalInt(tokens) || null } : {}),
      });
      onChanged();
    } catch (err) {
      setError(errorText(err, 'Failed to save budget'));
      setSaving(false);
    }
  }

  const dirty = mode !== budget.mode || (mode === 'separate'
    && ((optionalInt(requests) || null) !== budget.dailyRequestLimit || (optionalInt(tokens) || null) !== budget.dailyTokenLimit));

  return (
    <fieldset className="border border-border rounded-lg p-3 mb-4">
      <legend className="text-[13px] text-text-muted px-1">Budget</legend>
      <label className="min-h-11 md:min-h-8 flex items-start gap-2 text-sm text-text cursor-pointer">
        <input type="radio" name="agent-budget" checked={mode === 'shared'} onChange={() => setMode('shared')} className="accent-primary mt-1" />
        <span><b>Shared with the assistant</b> <span className="text-text-muted">Agent calls count toward the Chat capability's daily limits.</span></span>
      </label>
      <label className="min-h-11 md:min-h-8 flex items-start gap-2 text-sm text-text cursor-pointer">
        <input type="radio" name="agent-budget" checked={mode === 'separate'} onChange={() => setMode('separate')} className="accent-primary mt-1" />
        <span><b>Separate</b> <span className="text-text-muted">Agents have their own daily pool, and the assistant's Chat limits count only its own calls.</span></span>
      </label>
      {mode === 'separate' && (
        <div className="grid sm:grid-cols-2 gap-3 mt-2">
          <Input label="Agents' daily requests (optional)" id="agent-pool-req" type="number" min={1} value={requests} onChange={e => setRequests(e.target.value)} />
          <Input label="Agents' daily tokens (optional)" id="agent-pool-tok" type="number" min={1} value={tokens} onChange={e => setTokens(e.target.value)} />
        </div>
      )}
      <p className="text-xs text-text-muted mt-2">
        Today, all agents: {budget.today.requests} calls, {budget.today.tokens} tokens
        {budget.today.costMicros !== null ? `, ${formatMicros(budget.today.costMicros)}` : ''}. Each agent's own limits apply in both modes.
      </p>
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
      {dirty && <div className="mt-2"><Button onClick={save} loading={saving}>Save budget</Button></div>}
    </fieldset>
  );
}

function AgentRow({ serverId, agent, providers, adapters, channels, onChanged }: {
  serverId: string; agent: ModelAgent; providers: AIProvider[]; adapters: AIAdapter[]; channels: Channel[]; onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function run(fn: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <AgentForm
        serverId={serverId} agent={agent} providers={providers} adapters={adapters} channels={channels}
        onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); onChanged(); }}
      />
    );
  }

  return (
    <div className="border border-border rounded-lg p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-text">@{agent.name}</span>
        {!agent.enabled && <span className="text-xs px-1.5 py-0.5 rounded bg-surface-hover text-text-muted">paused</span>}
        <span className="text-sm text-text-muted break-all">{agent.providerLabel} · {agent.model}</span>
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" onClick={() => setEditing(true)} disabled={busy}>Edit</Button>
          <Button variant="secondary" loading={busy} onClick={() => run(() => aiApi.updateAgent(serverId, agent.id, { enabled: !agent.enabled }), 'Failed to update')}>
            {agent.enabled ? 'Pause' : 'Resume'}
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!window.confirm(`Delete @${agent.name}? Its bot is deleted too.`)) return;
              run(() => aiApi.deleteAgent(serverId, agent.id), 'Failed to delete');
            }}
          >
            Delete
          </Button>
        </div>
      </div>
      <p className="text-xs text-text-muted mt-1">
        {agent.tools.length ? `Tools: ${agent.tools.join(', ')}` : 'No tools (answers only)'} · up to {agent.maxSteps} steps ·
        {' '}in {agent.channelCount} channel{agent.channelCount === 1 ? '' : 's'} · today {agent.today.requests} calls, {agent.today.tokens} tokens
        {agent.today.costMicros !== null ? `, ${formatMicros(agent.today.costMicros)}` : ''}
      </p>
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </div>
  );
}

const optionalInt = (v: string): number | null => (v.trim() === '' ? null : Math.max(0, Math.floor(Number(v))));

function AgentForm({ serverId, agent, providers, channels, onCancel, onSaved }: {
  serverId: string; agent?: ModelAgent; providers: AIProvider[]; adapters: AIAdapter[]; channels: Channel[];
  onCancel: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(agent?.name ?? '');
  const [providerId, setProviderId] = useState(agent?.providerId ?? providers[0]?.id ?? '');
  const [model, setModel] = useState(agent?.model ?? '');
  const [systemPrompt, setSystemPrompt] = useState(agent?.systemPrompt ?? '');
  const [tools, setTools] = useState<Set<ModelAgentTool>>(new Set(agent?.tools ?? ['read_history', 'file_search', 'file_read']));
  const [maxSteps, setMaxSteps] = useState(agent?.maxSteps ?? 6);
  const [dailyRequests, setDailyRequests] = useState(agent?.dailyRequestLimit?.toString() ?? '');
  const [dailyTokens, setDailyTokens] = useState(agent?.dailyTokenLimit?.toString() ?? '');
  const [channelIds, setChannelIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const nameOk = !!agent || NAME.test(name);

  async function save() {
    setSaving(true);
    setError('');
    const settings = {
      providerId, model: model.trim(), systemPrompt: systemPrompt.trim() || null,
      tools: MODEL_AGENT_TOOLS.filter(t => tools.has(t)), maxSteps,
      dailyRequestLimit: optionalInt(dailyRequests) || null, dailyTokenLimit: optionalInt(dailyTokens) || null,
    };
    try {
      if (agent) await aiApi.updateAgent(serverId, agent.id, settings);
      else await aiApi.createAgent(serverId, { ...settings, name, channelIds: [...channelIds] });
      onSaved();
    } catch (err) {
      setError(errorText(err, 'Failed to save agent'));
      setSaving(false);
    }
  }

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value); else next.add(value);
    return next;
  };

  return (
    <div className="border border-border rounded-lg p-3 mb-3 flex flex-col gap-3">
      {!agent && (
        <Input
          label="Name (how people @mention it)" id="agent-name" value={name} onChange={e => setName(e.target.value)}
          placeholder="Scout" maxLength={32}
          error={name && !nameOk ? 'Letters, digits, - and _ only, up to 32 characters' : undefined}
        />
      )}
      <div className="flex flex-col gap-1">
        <label htmlFor="agent-provider" className="text-[13px] text-text-muted">Provider</label>
        <select id="agent-provider" value={providerId} onChange={e => setProviderId(e.target.value)} className={inputClass}>
          {providers.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </div>
      <Input
        label="Model" id="agent-model" value={model} onChange={e => setModel(e.target.value)}
        placeholder="e.g. anthropic/claude-sonnet-4.5 or openai/gpt-4.1-mini" maxLength={200}
      />
      <div className="flex flex-col gap-1">
        <label htmlFor="agent-prompt" className="text-[13px] text-text-muted">System prompt</label>
        <textarea
          id="agent-prompt" value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)} rows={4} maxLength={8000}
          placeholder="What this agent is for and how it should answer..." className={`w-full resize-y ${inputClass}`}
        />
        <p className="text-xs text-text-muted">Added after Agora's own rules (who may give instructions), which always apply.</p>
      </div>

      <fieldset>
        <legend className="text-[13px] text-text-muted mb-1">Tools</legend>
        <div className="grid sm:grid-cols-2 gap-1">
          {MODEL_AGENT_TOOLS.map(t => (
            <label key={t} className="min-h-11 md:min-h-8 flex items-center gap-2 text-sm text-text cursor-pointer">
              <input type="checkbox" checked={tools.has(t)} onChange={() => setTools(prev => toggle(prev, t))} className="accent-primary" />
              <span><code>{t}</code> <span className="text-text-muted">{TOOL_INFO[t]}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="grid sm:grid-cols-3 gap-3">
        <Input label="Max steps per mention" id="agent-steps" type="number" min={1} max={20} value={maxSteps}
          onChange={e => setMaxSteps(Math.min(20, Math.max(1, parseInt(e.target.value, 10) || 1)))} />
        <Input label="Daily requests (optional)" id="agent-req" type="number" min={1} value={dailyRequests} onChange={e => setDailyRequests(e.target.value)} />
        <Input label="Daily tokens (optional)" id="agent-tok" type="number" min={1} value={dailyTokens} onChange={e => setDailyTokens(e.target.value)} />
      </div>

      {!agent && channels.length > 0 && (
        <fieldset>
          <legend className="text-[13px] text-text-muted mb-1">Channels it can answer in</legend>
          <div className="flex flex-col gap-1 max-h-48 overflow-y-auto">
            {channels.map(ch => (
              <label key={ch.id} className="min-h-11 md:min-h-8 flex items-center gap-2 text-sm text-text cursor-pointer">
                <input type="checkbox" checked={channelIds.has(ch.id)} onChange={() => setChannelIds(prev => toggle(prev, ch.id))} className="accent-primary" />
                #{ch.name}
              </label>
            ))}
          </div>
          <p className="text-xs text-text-muted mt-1">More channels can be added later from the channel's agent list, like any bot.</p>
        </fieldset>
      )}

      {error && <p className="text-danger text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={save} loading={saving} disabled={!nameOk || !providerId || !model.trim()}>{agent ? 'Save' : 'Create agent'}</Button>
        <Button variant="secondary" onClick={onCancel} disabled={saving}>Cancel</Button>
      </div>
    </div>
  );
}
