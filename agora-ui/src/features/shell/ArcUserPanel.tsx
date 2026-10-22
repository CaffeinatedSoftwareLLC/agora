import { useState, useRef, useEffect, useId } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../stores/authStore';
import { usePalette } from '../../theme';
import { Avatar } from '../../components/ui/Avatar';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ArcUserPanelProps {
  /** true = server sidebar (36px avatar), false = home DM sidebar (40px avatar) */
  compact?: boolean;
}

// ─── Icons ──────────────────────────────────────────────────────────────────

const ICON = 'h-4 w-4 shrink-0';
const STROKE = { fill: 'none', viewBox: '0 0 24 24', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const AccountIcon = () => (
  <svg className={ICON} {...STROKE} aria-hidden="true">
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21v-1a6 6 0 016-6h4a6 6 0 016 6v1" />
  </svg>
);
const AdminIcon = () => (
  <svg className={ICON} {...STROKE} aria-hidden="true">
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M8 20h8M12 16v4" />
  </svg>
);
const LogoutIcon = () => (
  <svg className={ICON} {...STROKE} aria-hidden="true">
    <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
    <polyline points="16 17 21 12 16 7" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);
const LogoutAllIcon = () => (
  <svg className={ICON} {...STROKE} aria-hidden="true">
    <rect x="3" y="4" width="11" height="16" rx="2" />
    <polyline points="17 16 21 12 17 8" />
    <line x1="21" y1="12" x2="9" y2="12" />
  </svg>
);

// ─── Component ──────────────────────────────────────────────────────────────

export function ArcUserPanel({ compact = false }: ArcUserPanelProps) {
  const P = usePalette();
  const navigate = useNavigate();
  const user = useAuthStore(s => s.user);
  const logout = useAuthStore(s => s.logout);
  const logoutAll = useAuthStore(s => s.logoutAll);

  const [menuOpen, setMenuOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // Which item takes focus when the menu opens: first (click, Enter, ArrowDown) or last (ArrowUp)
  const openFocus = useRef<'first' | 'last'>('first');
  const menuId = useId();
  const errorId = useId();

  const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const openMenu = (focus: 'first' | 'last') => {
    openFocus.current = focus;
    setLogoutError('');
    setMenuOpen(true);
  };

  const closeMenu = (restoreFocus: boolean) => {
    setMenuOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };

  // Move focus into the menu once it renders
  useEffect(() => {
    if (!menuOpen) return;
    const list = items();
    (openFocus.current === 'last' ? list[list.length - 1] : list[0])?.focus();
  }, [menuOpen]);

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

  const displayName = user?.username ?? 'Unknown';

  // Size variants
  const avatarSize = compact ? 'w-9 h-9' : 'w-10 h-10';

  const go = (path: string) => {
    setMenuOpen(false);
    navigate(path);
  };

  const handleLogout = () => {
    setMenuOpen(false);
    logout();
    navigate('/login');
  };

  const handleLogoutAll = async () => {
    // aria-disabled rather than disabled, so the item keeps keyboard focus while pending
    if (revoking) return;
    setRevoking(true);
    setLogoutError('');
    try {
      await logoutAll();
      navigate('/login');
    } catch {
      setLogoutError('Could not log out all sessions. Try again.');
    } finally { setRevoking(false); }
  };

  const onTriggerKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); openMenu('first'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); openMenu('last'); }
  };

  const onMenuKeyDown = (e: ReactKeyboardEvent) => {
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const focusAt = (i: number) => list[(i + list.length) % list.length]?.focus();
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); focusAt(at + 1); break;
      case 'ArrowUp': e.preventDefault(); focusAt(at - 1); break;
      case 'Home': e.preventDefault(); focusAt(0); break;
      case 'End': e.preventDefault(); focusAt(list.length - 1); break;
      case 'Escape': e.preventDefault(); closeMenu(true); break;
      case 'Tab': setMenuOpen(false); break;
    }
  };

  const itemClass = 'w-full min-h-11 md:min-h-9 flex items-center gap-2.5 px-3 py-2 text-[13px] text-left rounded-lg outline-none transition-colors aria-disabled:opacity-50 aria-disabled:cursor-default';
  const plainItem = `${itemClass} hover:bg-surface-hover focus-visible:bg-surface-hover`;
  const dangerItem = `${itemClass} hover:bg-danger/10 focus-visible:bg-danger/10`;

  return (
    <div
      className={compact ? 'px-2 py-2 shrink-0' : 'px-3 py-3 shrink-0'}
      style={{ borderTop: `1px solid ${P.border}` }}
    >
      <div
        className="relative flex items-center gap-2.5 pl-2 pr-1 py-1.5 rounded-xl"
        style={{ background: P.bg, border: `1px solid ${P.border}` }}
      >
        {/* ── Avatar + presence dot ─────────────────────────────────────── */}
        <div className="relative shrink-0">
          <Avatar userId={user?.id} username={displayName} className={`${avatarSize} text-[13px]`} />
          <span
            className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full"
            style={{ backgroundColor: P.online, boxShadow: `0 0 0 2.5px ${P.bg}` }}
            aria-hidden="true"
          />
        </div>

        {/* ── Name + status ──────────────────────────────────────────────── */}
        <div className="flex-1 min-w-0 leading-tight">
          <div className="text-[13px] font-semibold truncate" style={{ color: P.text }} title={displayName}>
            {displayName}
          </div>
          <div className="text-[11px] truncate" style={{ color: P.muted }}>
            Online
          </div>
        </div>

        {/* ── Account menu ───────────────────────────────────────────────── */}
        <button
          ref={buttonRef}
          onClick={() => (menuOpen ? closeMenu(false) : openMenu('first'))}
          onKeyDown={onTriggerKeyDown}
          className="shrink-0 min-h-11 min-w-11 md:min-h-9 md:min-w-9 md:h-9 md:w-9 rounded-lg flex items-center justify-center transition-colors hover:bg-surface-hover"
          style={{ color: menuOpen ? P.text : P.muted, background: menuOpen ? P.surfaceHover : undefined }}
          title="Account menu"
          aria-label="Account menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={menuOpen ? menuId : undefined}
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="5" r="1.75" />
            <circle cx="12" cy="12" r="1.75" />
            <circle cx="12" cy="19" r="1.75" />
          </svg>
        </button>

        {/* The error sits beside the menu, not in it: a menu may only hold menu items */}
        {menuOpen && (
          <div
            ref={menuRef}
            className="absolute bottom-full left-0 right-0 mb-2 rounded-xl p-1 shadow-lg z-50"
            style={{ background: P.surface, border: `1px solid ${P.border}` }}
          >
            <div id={menuId} role="menu" aria-label="Account" onKeyDown={onMenuKeyDown}>
              <button role="menuitem" tabIndex={-1} onClick={() => go('/account')} className={plainItem} style={{ color: P.text }}>
                <span style={{ color: P.muted }}><AccountIcon /></span>
                Account &amp; security
              </button>
              {user?.isInstanceAdmin && (
                <button role="menuitem" tabIndex={-1} onClick={() => go('/admin')} className={plainItem} style={{ color: P.text }}>
                  <span style={{ color: P.muted }}><AdminIcon /></span>
                  Instance admin
                </button>
              )}
              <div role="separator" className="my-1 h-px" style={{ background: P.border }} />
              <button role="menuitem" tabIndex={-1} onClick={handleLogout} className={dangerItem} style={{ color: P.danger }}>
                <LogoutIcon />
                Log out
              </button>
              <button
                role="menuitem"
                tabIndex={-1}
                onClick={handleLogoutAll}
                aria-disabled={revoking}
                aria-describedby={logoutError ? errorId : undefined}
                className={dangerItem}
                style={{ color: P.danger }}
              >
                <LogoutAllIcon />
                {revoking ? 'Logging out…' : 'Log out all sessions'}
              </button>
            </div>
            {logoutError && <p id={errorId} role="alert" className="px-3 py-2 text-xs" style={{ color: P.danger }}>{logoutError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
