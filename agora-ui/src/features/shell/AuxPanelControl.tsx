import { useUIStore } from '../../stores/uiStore';

/** Uses the shell close action so browser Back and focus restoration stay in sync. */
export function AuxPanelControl({ label }: { label: string }) {
  return (
    <button type="button" onClick={() => useUIStore.getState().closeAux()}
      className="min-h-11 min-w-11 shrink-0 rounded-lg px-2 text-text-muted hover:bg-surface-hover xl:order-last"
      aria-label={`Back / Close ${label}`}>
      <span className="xl:hidden">&larr; Back</span>
      <span className="hidden xl:inline" aria-hidden="true">&#10005;</span>
    </button>
  );
}
