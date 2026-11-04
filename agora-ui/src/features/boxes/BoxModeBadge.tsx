import { boxModeLabel, type BoxMode } from './boxRules';

/**
 * "boxed" / "unboxed" next to an agent's name (docs/agent-boxes.md §10). Unboxed agents run on
 * the machine itself and can read and change its files, so they get the warning tone.
 */
export function BoxModeBadge({ profile, className = '' }: { profile: BoxMode | null | undefined; className?: string }) {
  const label = boxModeLabel(profile);
  if (!label) return null;
  const tone = label === 'boxed' ? 'bg-online/15 text-online' : 'bg-warn/20 text-warn';
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold leading-none ${tone} ${className}`}
      title={label === 'boxed' ? 'Runs in its own box' : 'Runs unboxed on its host machine: it can read and change that machine\'s files'}
      data-testid="box-mode"
    >
      {label}
    </span>
  );
}
