import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { usePalette, hexToRgb } from '../../theme';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ArcUserPanelProps {
  /** true = server sidebar (36px avatar), false = home DM sidebar (40px avatar) */
  compact?: boolean;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ArcUserPanel({ compact = false }: ArcUserPanelProps) {
  const P = usePalette();
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  const isAdmin = user?.isInstanceAdmin === true;

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const initial = user?.username?.[0]?.toUpperCase() ?? '?';
  const displayName = user?.username ?? 'Unknown';

  // Size variants
  const avatarRingSize = compact ? 'w-9 h-9' : 'w-10 h-10';
  const avatarRingPadding = compact ? 'p-[2px]' : 'p-[2.5px]';
  const avatarTextSize = compact ? 'text-xs' : 'text-sm';
  const nameFontSize = compact ? 'text-[12px]' : 'text-[13px]';
  const statusFontSize = compact ? 'text-[10px]' : 'text-[11px]';
  const statusColor = compact ? P.dim : P.muted;
  const iconSize = compact ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const buttonSize = compact ? 'h-6 w-6 rounded-md' : 'p-1.5 rounded-md';

  const handleLogout = () => {
    setMenuOpen(false);
    logout();
    navigate('/login');
  };

  return (
    <div
      className={compact ? 'px-2 py-2.5 shrink-0' : 'px-3 py-3 shrink-0'}
      style={{ borderTop: `1px solid ${P.border}` }}
    >
      <div
        className={
          compact
            ? 'flex items-center gap-2.5 px-2.5 py-2 rounded-xl'
            : 'flex items-center gap-3 px-3 py-2 rounded-xl'
        }
        style={{ background: P.bg }}
      >
        {/* ── Avatar with gradient ring ──────────────────────────────────── */}
        <div className="relative shrink-0">
          <div
            className={`${avatarRingSize} rounded-full ${avatarRingPadding}`}
            style={{ background: 'linear-gradient(135deg, #F97316, #C77DFF)' }}
          >
            <div
              className={`w-full h-full rounded-full flex items-center justify-center ${avatarTextSize} font-bold`}
              style={{ background: P.bg, color: P.text }}
            >
              {initial}
            </div>
          </div>
          {/* Presence dot (online, bottom-left) */}
          <div className="absolute -bottom-0.5 -left-0.5">
            <div
              className="w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: P.online, boxShadow: `0 0 0 2.5px ${P.bg}` }}
            />
          </div>
        </div>

        {/* ── Name + status ──────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0">
          <div className={`${nameFontSize} font-semibold truncate`} style={{ color: P.text }}>
            {displayName}
          </div>
          <div className={`${statusFontSize} truncate`} style={{ color: statusColor }}>
            Online
          </div>
        </div>

        {/* ── Mic button ─────────────────────────────────────────────────── */}
        <button
          className={`${buttonSize} flex items-center justify-center transition-colors`}
          style={{ color: P.dim }}
        >
          <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z" />
            <path d="M19 10v2a7 7 0 01-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </button>

        {/* ── Admin button (instance admins only) ──────────────────────── */}
        {isAdmin && (
          <button
            onClick={() => navigate('/admin')}
            className={`${buttonSize} flex items-center justify-center transition-colors`}
            style={{ color: P.dim }}
            title="Instance Settings"
          >
            <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            </svg>
          </button>
        )}

        {/* ── Settings button + menu ───────────────────────────────────── */}
        <div className="relative">
          <button
            ref={buttonRef}
            onClick={() => setMenuOpen(!menuOpen)}
            className={`${buttonSize} flex items-center justify-center transition-colors`}
            style={{ color: menuOpen ? P.text : P.dim }}
            title="Settings"
          >
            <svg className={iconSize} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
            </svg>
          </button>

          {/* Popover menu */}
          {menuOpen && (
            <div
              ref={menuRef}
              className="absolute bottom-full right-0 mb-2 w-44 rounded-lg py-1 shadow-lg z-50"
              style={{
                background: P.surface,
                border: `1px solid ${P.border}`,
              }}
            >
              <button
                onClick={handleLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-[13px] text-left transition-colors"
                style={{ color: P.danger }}
                onMouseEnter={e => (e.currentTarget.style.background = `rgba(${hexToRgb(P.danger)}, 0.1)`)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                {/* Log out icon */}
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
                  <polyline points="16 17 21 12 16 7" />
                  <line x1="21" y1="12" x2="9" y2="12" />
                </svg>
                Log Out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
