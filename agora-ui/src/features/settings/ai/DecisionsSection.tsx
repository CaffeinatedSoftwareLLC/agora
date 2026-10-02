import { useState } from 'react';
import { aiApi, ApiError } from '../../../lib/api';
import type { AIDecisionSettings, AIDecisionSettingsPatch, AIDecisionUse } from '../../../lib/api';
import { Button } from '../../../components/ui/Button';
import { inputClass, parseLimit } from './format';

const USES: { use: AIDecisionUse; label: string; description: string }[] = [
  { use: 'routing', label: 'Assistant routing', description: 'Works out what an @assistant request is asking for and sends it to the right handler.' },
  { use: 'search_screening', label: 'Search screening', description: 'Checks web search results for text that tries to give instructions to the AI reading it.' },
  { use: 'file_tagging', label: 'File tagging', description: 'Tags each uploaded text file. The file’s text is sent to the decision provider.' },
  { use: 'file_ranking', label: 'File ranking', description: 'Ranks files against a search. The text of the top candidates is sent to the decision provider.' },
];

interface Props {
  serverId: string;
  settings: AIDecisionSettings;
  onChanged: () => void;
}

/** A 0–1 value shown and edited as a whole percent. */
const toPct = (v: number) => String(Math.round(v * 100));
function parsePct(input: string): number | undefined {
  const value = Number(input.trim());
  if (input.trim() === '' || !Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return value / 100;
}

/**
 * Decision model settings. The model is optional: with every use off (the default)
 * nothing here runs and nothing is sent anywhere. The provider and model are chosen
 * under Capabilities → Decide; this section says what the model is used for.
 */
export function DecisionsSection({ serverId, settings, onChanged }: Props) {
  const [uses, setUses] = useState(() => Object.fromEntries(USES.map(({ use }) => [use, {
    enabled: settings.uses[use].enabled,
    sharePct: String(settings.uses[use].sharePct),
    dailyRequests: settings.uses[use].dailyRequests?.toString() ?? '',
  }])) as Record<AIDecisionUse, { enabled: boolean; sharePct: string; dailyRequests: string }>);
  const [strict, setStrict] = useState(settings.screeningStrict);
  const [flag, setFlag] = useState(toPct(settings.screeningFlagThreshold));
  const [suspect, setSuspect] = useState(toPct(settings.screeningSuspectThreshold));
  const [confidence, setConfidence] = useState(toPct(settings.routingMinConfidence));
  const [tagThreshold, setTagThreshold] = useState(toPct(settings.tagThreshold));
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setUse = (use: AIDecisionUse, change: Partial<typeof uses[AIDecisionUse]>) =>
    setUses(prev => ({ ...prev, [use]: { ...prev[use], ...change } }));

  const shareTotal = USES.reduce((sum, { use }) => sum + (Number(uses[use].sharePct) || 0), 0);

  async function save() {
    const patch: AIDecisionSettingsPatch = { uses: {}, screeningStrict: strict };
    for (const { use, label } of USES) {
      const share = Number(uses[use].sharePct);
      const cap = parseLimit(uses[use].dailyRequests);
      if (uses[use].sharePct.trim() === '' || !Number.isInteger(share) || share < 0 || share > 100) {
        setError(`${label}: the budget share must be a whole number from 0 to 100.`);
        return;
      }
      if (cap === undefined) {
        setError(`${label}: the daily request cap must be a positive whole number, or blank.`);
        return;
      }
      patch.uses![use] = { enabled: uses[use].enabled, sharePct: share, dailyRequests: cap };
    }
    if (shareTotal > 100) {
      setError(`Budget shares add up to ${shareTotal}%. They must total 100% or less.`);
      return;
    }
    const thresholds = { flag: parsePct(flag), suspect: parsePct(suspect), confidence: parsePct(confidence), tag: parsePct(tagThreshold) };
    if (Object.values(thresholds).some(v => v === undefined)) {
      setError('Thresholds must be numbers from 0 to 100.');
      return;
    }
    if (thresholds.suspect! > thresholds.flag!) {
      setError('The “mark as suspect” threshold must not be above the “withhold” threshold.');
      return;
    }
    patch.screeningFlagThreshold = thresholds.flag;
    patch.screeningSuspectThreshold = thresholds.suspect;
    patch.routingMinConfidence = thresholds.confidence;
    patch.tagThreshold = thresholds.tag;

    setSaving(true);
    setError('');
    try {
      await aiApi.patchDecisions(serverId, patch);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.message || err.code) : 'Failed to save');
      setSaving(false);
    }
  }

  const { route } = settings;
  const anyOn = USES.some(({ use }) => uses[use].enabled);

  return (
    <section className="mb-10">
      <h3 className="text-lg font-semibold text-text mb-2">Decision model</h3>
      <p className="text-sm text-text-muted mb-3">
        Optional. A decision model answers quick yes/no and pick-one questions about text; it writes nothing.
        Everything below is off until you turn it on, and Agora works the same without it.
      </p>

      <p className="text-sm mb-3">
        {route.configured ? (
          <span className={route.enabled ? 'text-text-muted' : 'text-warn'}>
            Model: {route.provider} · {route.model}{route.enabled ? '' : ' (off)'}
          </span>
        ) : (
          <span className={anyOn ? 'text-warn' : 'text-text-dim'}>
            No decision model yet. Add a provider that supports decisions, then set Capabilities → Decide.
          </span>
        )}
      </p>

      {settings.warnings.map(w => (
        <p key={w} className="text-sm text-warn border border-border rounded px-3 py-2 mb-3">{w}</p>
      ))}

      <div className="flex flex-col gap-2">
        {USES.map(({ use, label, description }) => (
          <div key={use} className="border border-border rounded-lg px-4 py-3">
            <label className="flex items-start gap-3 cursor-pointer">
              <input
                type="checkbox"
                className="accent-primary mt-1"
                checked={uses[use].enabled}
                onChange={e => setUse(use, { enabled: e.target.checked })}
              />
              <span>
                <span className="text-text font-medium">{label}</span>
                <span className="block text-xs text-text-dim">{description}</span>
              </span>
              <span className="ml-auto text-xs text-text-dim whitespace-nowrap">
                Today: {settings.today[use].requests} req
                {settings.today[use].errors > 0 && <span className="text-danger"> · {settings.today[use].errors} failed</span>}
              </span>
            </label>

            {use === 'search_screening' && (
              <label className="flex items-start gap-3 mt-3 ml-7 cursor-pointer">
                <input type="checkbox" className="accent-primary mt-1" checked={strict} onChange={e => setStrict(e.target.checked)} />
                <span className="text-sm text-text-muted">
                  Strict: refuse a search when its results could not be screened
                  <span className="block text-xs text-text-dim">
                    Off: results are returned with a note saying they were not screened. Screening lowers risk; it is not a guarantee.
                  </span>
                </span>
              </label>
            )}

            {showAdvanced && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 ml-7">
                <NumberField label="Share of the daily budget (%)" value={uses[use].sharePct} onChange={v => setUse(use, { sharePct: v })} placeholder="0–100" />
                <NumberField label="Request cap / day" value={uses[use].dailyRequests} onChange={v => setUse(use, { dailyRequests: v })} placeholder="none" />
                {use === 'routing' && (
                  <NumberField label="Minimum confidence to route (%)" value={confidence} onChange={setConfidence} placeholder="60" />
                )}
                {use === 'search_screening' && (
                  <>
                    <NumberField label="Withhold text at or above (%)" value={flag} onChange={setFlag} placeholder="70" />
                    <NumberField label="Mark as suspect at or above (%)" value={suspect} onChange={setSuspect} placeholder="35" />
                  </>
                )}
                {use === 'file_tagging' && (
                  <NumberField label="Apply a tag at or above (%)" value={tagThreshold} onChange={setTagThreshold} placeholder="50" />
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {showAdvanced && (
        <p className="text-xs text-text-dim mt-2">
          Each use may spend its share of the limits set on Capabilities → Decide, and shares are not borrowed, so
          one use cannot starve another. Shares total {shareTotal}% (maximum 100%). A share of 0 switches a use off.
          If Decide has no limits, only the request caps here apply.
        </p>
      )}

      <div className="flex items-center gap-3 mt-3">
        <Button onClick={save} loading={saving}>Save</Button>
        <button className="text-sm text-primary hover:underline" onClick={() => setShowAdvanced(v => !v)}>
          {showAdvanced ? 'Hide budgets and thresholds' : 'Budgets and thresholds'}
        </button>
      </div>
      {error && <p className="text-danger text-sm mt-2">{error}</p>}
    </section>
  );
}

function NumberField({ label, value, onChange, placeholder }: {
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
        inputMode="numeric"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}
