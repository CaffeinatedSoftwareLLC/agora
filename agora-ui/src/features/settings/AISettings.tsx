import { useEffect, useMemo, useState } from 'react';
import { useServerStore } from '../../stores/serverStore';
import { useServerAccess } from '../../hooks/useServerAccess';
import { aiApi, botApi, serverApi, ApiError } from '../../lib/api';
import type { AIAdapter, AICapabilityUsage, AIConfig, AIProvider, AIRoute } from '../../lib/api';
import type { Channel } from '../../lib/contracts/server';
import { ProvidersSection } from './ai/ProvidersSection';
import { RoutesSection } from './ai/RoutesSection';
import { AssistantSection } from './ai/AssistantSection';
import { UsageSection } from './ai/UsageSection';

const USAGE_DAYS = 30;

interface AIState {
  adapters: AIAdapter[];
  providers: AIProvider[];
  routes: AIRoute[];
  config: AIConfig;
  channels: Channel[];
  botChannelIds: Set<string>;
  usage: AICapabilityUsage[];
}

export function AISettings() {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const { isInstanceAdmin } = useServerAccess(instanceServerId);
  const [state, setState] = useState<AIState | null>(null);
  const [error, setError] = useState('');
  const [version, setVersion] = useState(0);
  const [allowPrivate, setAllowPrivate] = useState<boolean | null>(null);

  const reload = () => setVersion(v => v + 1);

  useEffect(() => {
    if (!instanceServerId) return;
    let cancelled = false;
    (async () => {
      try {
        const [adapters, providers, routes, config, channels, usage] = await Promise.all([
          aiApi.listAdapters(instanceServerId),
          aiApi.listProviders(instanceServerId),
          aiApi.listRoutes(instanceServerId),
          aiApi.getConfig(instanceServerId),
          serverApi.getChannels(instanceServerId),
          aiApi.getCapabilityUsage(instanceServerId, USAGE_DAYS),
        ]);
        let botChannelIds = new Set<string>();
        if (config.configured && config.botId) {
          try {
            const bot = await botApi.get(instanceServerId, config.botId);
            botChannelIds = new Set(bot.channels.map(c => c.id));
          } catch { /* bot may have been deleted */ }
        }
        if (cancelled) return;
        setState({
          adapters,
          providers,
          routes,
          config,
          channels: channels.filter(c => c.channelType === 3), // server text channels
          botChannelIds,
          usage: usage.capabilities,
        });
        setError('');
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.code : 'Failed to load AI settings');
      }
    })();
    return () => { cancelled = true; };
  }, [instanceServerId, version]);

  useEffect(() => {
    if (!isInstanceAdmin) return;
    let cancelled = false;
    aiApi.getInstanceAISettings()
      .then(s => { if (!cancelled) setAllowPrivate(s.allowPrivateBaseUrls); })
      .catch(() => { /* not critical */ });
    return () => { cancelled = true; };
  }, [isInstanceAdmin]);

  // Test each provider with the model its chat route uses, when it has one
  const testModels = useMemo(() => {
    const out: Record<string, string> = {};
    for (const r of state?.routes ?? []) if (r.capability === 'chat') out[r.providerId] = r.model;
    return out;
  }, [state?.routes]);

  if (!instanceServerId) return null;

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold text-text mb-1">AI</h2>
      <p className="text-sm text-text-muted mb-6">
        Connect any mix of AI providers and choose which one handles each job.
      </p>
      {error && <p className="text-danger text-sm mb-4">{error}</p>}
      {!state ? (
        !error && <p className="text-text-muted">Loading...</p>
      ) : (
        <>
          <ProvidersSection
            serverId={instanceServerId}
            adapters={state.adapters}
            providers={state.providers}
            testModels={testModels}
            isInstanceAdmin={isInstanceAdmin}
            allowPrivateBaseUrls={allowPrivate}
            onChanged={reload}
            onAllowPrivateChanged={async value => {
              try {
                const res = await aiApi.setAllowPrivateBaseUrls(value);
                setAllowPrivate(res.allowPrivateBaseUrls);
              } catch (err) {
                setError(err instanceof ApiError ? err.code : 'Failed to update instance setting');
              }
            }}
          />
          <RoutesSection
            serverId={instanceServerId}
            adapters={state.adapters}
            providers={state.providers}
            routes={state.routes}
            onChanged={reload}
          />
          <AssistantSection
            key={`${state.config.botId ?? 'none'}:${state.config.updatedAt ?? ''}:${state.config.enabled}`}
            serverId={instanceServerId}
            config={state.config}
            hasChatRoute={state.routes.some(r => r.capability === 'chat' && r.enabled)}
            channels={state.channels}
            botChannelIds={state.botChannelIds}
            onChanged={reload}
          />
          <UsageSection usage={state.usage} days={USAGE_DAYS} />
        </>
      )}
    </div>
  );
}
