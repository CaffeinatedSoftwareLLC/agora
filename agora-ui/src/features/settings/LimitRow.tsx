import { useId, useRef } from 'react';

/**
 * One limit as a settings row: "No limit" (the default) or a number the user types, with one
 * line saying what the limit does. Agora only shows that the limit exists; turning it on is the
 * user's choice, and any positive whole number is accepted.
 *
 * `value` is null for "no limit", else the field's text (possibly empty or invalid while typing).
 */
export function LimitRow({ label, hint, unit, name, value, onChange, invalid }: {
  label: string;
  /** What the limit does when it is on, in one line. */
  hint: string;
  /** What the number counts, after the field: "wakes", "tokens", "minutes". */
  unit: string;
  /** Whose limit, for the controls' accessible names: "Wakes per session for cci". */
  name: string;
  value: string | null;
  onChange: (value: string | null) => void;
  invalid?: boolean;
}) {
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  const on = value !== null;
  const choice = 'flex min-h-11 cursor-pointer items-center gap-1.5 text-sm text-text md:min-h-8';
  return (
    <fieldset className="min-w-0 border-t border-border py-2 first:border-t-0">
      <legend className="sr-only">{name}</legend>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="w-full text-sm font-medium text-text sm:w-40" aria-hidden="true">{label}</span>
        <label className={choice}>
          <input type="radio" name={id} className="accent-primary" checked={!on} onChange={() => onChange(null)} aria-label={`No limit: ${name}`} />
          No limit
        </label>
        <label className={choice}>
          <input type="radio" name={id} className="accent-primary" checked={on} aria-label={`Set a limit: ${name}`}
            onChange={() => { onChange(''); requestAnimationFrame(() => field.current?.focus()); }} />
          Limit to
        </label>
        {on && (
          <span className="flex min-w-0 items-center gap-1.5">
            <input ref={field} type="number" min={1} step={1} inputMode="numeric" value={value} aria-label={name} aria-invalid={invalid || undefined}
              onChange={e => onChange(e.target.value)}
              className={`min-h-11 w-40 max-w-full rounded border bg-bg px-3 py-1.5 text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary md:min-h-9 ${invalid ? 'border-danger' : 'border-border'}`} />
            <span className="text-xs text-text-muted">{unit}</span>
          </span>
        )}
      </div>
      <p className="mt-0.5 text-xs text-text-muted">{hint}</p>
    </fieldset>
  );
}
