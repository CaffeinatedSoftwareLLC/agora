import { useNavigate } from 'react-router-dom';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { usePalette, hexToRgb } from '../../theme';
import { NotificationBell } from '../notifications/NotificationBell';

// ─── Component ──────────────────────────────────────────────────────────────

export function TabBar() {
  const navigate = useNavigate();
  const P = usePalette();

  // UI store
  const paletteKey = useUIStore(s => s.paletteKey);
  const togglePalette = useUIStore(s => s.togglePalette);

  // Server store
  const servers = useServerStore(s => s.servers);
  const instanceServerId = useServerStore(s => s.instanceServerId);

  // Derived
  const instanceServer = instanceServerId ? servers.get(instanceServerId) ?? null : null;
  const instanceName = instanceServer?.name ?? 'Agora';

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleChannelsClick = () => {
    navigate('/app');
  };

  // ── Render ────────────────────────────────────────────────────────────────

  const accentRgb = hexToRgb(P.accent);

  return (
    <>
      {/* Tab bar container */}
      <div
        className="flex items-center gap-1 px-3 pt-2 pb-0 shrink-0"
        style={{
          background: `linear-gradient(180deg, rgba(${accentRgb}, 0.06) 0%, transparent 100%)`,
        }}
      >
        {/* ── Instance name / Channels tab ────────────────────────────────── */}
        <button
          onClick={handleChannelsClick}
          className="relative flex items-center gap-2 min-h-11 md:min-h-9 px-4 py-2 text-[13px] font-medium transition-all duration-200 rounded-t-xl shrink-0"
          style={{
            background: `linear-gradient(180deg, rgba(${accentRgb}, 0.15) 0%, rgba(${accentRgb}, 0.04) 100%)`,
            boxShadow: `0 1px 0 0 rgba(${accentRgb}, 0.3), inset 0 1px 0 0 rgba(${accentRgb}, 0.12)`,
            color: P.text,
          }}
        >
          {/* Hash icon */}
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="9" x2="20" y2="9" />
            <line x1="4" y1="15" x2="20" y2="15" />
            <line x1="10" y1="3" x2="8" y2="21" />
            <line x1="16" y1="3" x2="14" y2="21" />
          </svg>
          {instanceName}

          {/* Active underline */}
          <span
            className="absolute bottom-0 left-3 right-3 h-0.5 rounded-full"
            style={{ background: `linear-gradient(90deg, transparent, ${P.accent}, transparent)` }}
          />
        </button>

        {/* Spacer */}
        <div className="flex-1" />

        {/* ── Right controls ───────────────────────────────────────────────── */}
        <div className="flex items-center gap-1 ml-2 shrink-0">
          <NotificationBell />
          {/* Palette toggle */}
          <button
            onClick={togglePalette}
            className="flex items-center gap-1.5 min-h-11 md:min-h-8 px-3 py-1.5 rounded-full text-[13px] font-medium transition-all hover:opacity-90"
            style={{ background: P.surface, border: `1px solid ${P.border}`, color: P.text }}
            title="Switch theme palette"
            aria-label={`Switch theme palette (current: ${paletteKey === 'aegean' ? 'Aegean' : 'Terracotta'})`}
          >
            <span className="h-3 w-3 rounded-full shrink-0" style={{ background: P.primary, border: `1.5px solid ${P.accent}` }} />
            {paletteKey === 'aegean' ? 'Aegean' : 'Terracotta'}
          </button>
        </div>
      </div>

      {/* ── Accent gradient bar ────────────────────────────────────────────── */}
      <div
        className="h-px shrink-0"
        style={{
          background: `linear-gradient(90deg, transparent, rgba(${accentRgb}, 0.2), transparent)`,
        }}
      />
    </>
  );
}
