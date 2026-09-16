import { useNavigate } from 'react-router-dom';
import { useUIStore } from '../../stores/uiStore';
import { useServerStore } from '../../stores/serverStore';
import { usePalette, hexToRgb } from '../../theme';

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
          className="relative flex items-center gap-2 px-4 py-2 text-[13px] font-medium transition-all duration-200 rounded-t-xl shrink-0"
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
          {/* Palette toggle */}
          <button
            onClick={togglePalette}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-medium transition-all"
            style={{ background: `${P.surface}88`, border: `1px solid ${P.border}`, color: P.muted }}
          >
            <span className="h-3 w-3 rounded-full" style={{ background: P.bg, border: `1.5px solid ${P.accent}` }} />
            {paletteKey === 'aegean' ? 'Aegean' : 'Terracotta'}
          </button>

          {/* Search pill (Ctrl+K) */}
          <button
            className="flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] transition-all"
            style={{ background: `${P.surface}88`, border: `1px solid ${P.border}`, color: P.dim }}
          >
            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
            </svg>
            <span className="hidden xl:inline">Search</span>
            <kbd className="hidden xl:inline px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background: P.bg, color: P.dim }}>
              Ctrl+K
            </kbd>
          </button>

          {/* Notification bell */}
          <button className="relative h-8 w-8 rounded-lg flex items-center justify-center transition-colors" style={{ color: P.dim }}>
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.73 21a2 2 0 01-3.46 0" />
            </svg>
            <span className="absolute top-1 right-1 h-2 w-2 rounded-full" style={{ background: P.danger }} />
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
