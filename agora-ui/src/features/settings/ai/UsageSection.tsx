import type { AICapabilityUsage } from '../../../lib/api';
import { CAPABILITY_INFO, formatMicros } from './format';

export function UsageSection({ usage, days }: { usage: AICapabilityUsage[]; days: number }) {
  return (
    <section>
      <h3 className="text-lg font-semibold text-text mb-3">Usage (last {days} days)</h3>
      {usage.length === 0 ? (
        <p className="text-text-dim text-sm">No AI calls yet.</p>
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
                  <td className="py-2 pr-4">{CAPABILITY_INFO[u.capability]?.label ?? u.capability}</td>
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
          <p className="text-xs text-text-dim mt-2">Cost is estimated from the prices set on each capability; blank if none are set.</p>
        </div>
      )}
    </section>
  );
}
