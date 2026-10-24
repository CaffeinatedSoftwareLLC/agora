import type { AICapabilityUsage } from '../../../lib/api';
import { CAPABILITY_INFO, formatMicros } from './format';

const label = (c: AICapabilityUsage['capability'], agentBudget: 'shared' | 'separate') =>
  c === 'model_agents'
    ? `Model agents${agentBudget === 'shared' ? ' (count toward Chat limits)' : ' (own budget)'}`
    : CAPABILITY_INFO[c]?.label ?? c;

export function UsageSection({ usage, days, agentBudget = 'shared' }: { usage: AICapabilityUsage[]; days: number; agentBudget?: 'shared' | 'separate' }) {
  return (
    <section>
      <h3 className="text-lg font-semibold text-text mb-3">Usage (last {days} days)</h3>
      {usage.length === 0 ? (
        <p className="text-text-muted text-sm">No AI calls yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted text-xs">
                <th className="py-2 pr-4 font-medium">Capability</th>
                <th className="py-2 pr-4 font-medium text-right">Requests</th>
                <th className="py-2 pr-4 font-medium text-right">Tokens in / out</th>
                <th className="py-2 pr-4 font-medium text-right">Est. cost</th>
                <th className="py-2 pr-4 font-medium text-right">Errors</th>
                <th className="py-2 font-medium text-right">Today</th>
              </tr>
            </thead>
            <tbody>
              {usage.map(u => (
                <tr key={u.capability} className="border-t border-border text-text">
                  <td className="py-2 pr-4">{label(u.capability, agentBudget)}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{u.requests.toLocaleString()}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">
                    {u.inputTokens.toLocaleString()} / {u.outputTokens.toLocaleString()}
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{formatMicros(u.costMicros)}</td>
                  <td className={`py-2 pr-4 text-right tabular-nums ${u.errors > 0 ? 'text-danger' : ''}`}>{u.errors}</td>
                  <td className="py-2 text-right tabular-nums text-text-muted">
                    {u.today.requests} req · {u.today.tokens.toLocaleString()} tok
                    {u.today.costMicros !== null ? ` · ${formatMicros(u.today.costMicros)}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-xs text-text-muted mt-2">Cost is estimated from the prices set on each capability; blank if none are set.</p>
        </div>
      )}
    </section>
  );
}
