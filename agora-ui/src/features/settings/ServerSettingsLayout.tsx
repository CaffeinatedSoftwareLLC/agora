import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { NavLink, Link, useLocation } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';

const NARROW_SETTINGS = '(max-width: 639px)';
const isNarrow = () => window.matchMedia(NARROW_SETTINGS).matches;
function subscribeWidth(listener: () => void) {
  const media = window.matchMedia(NARROW_SETTINGS);
  media.addEventListener('change', listener);
  return () => media.removeEventListener('change', listener);
}

export function ServerSettingsLayout({ children }: { children: ReactNode }) {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const isAdmin = useAuthStore(s => s.user?.isInstanceAdmin) === true;
  const { pathname } = useLocation();
  const narrow = useSyncExternalStore(subscribeWidth, isNarrow, () => false);
  const atIndex = pathname.replace(/\/$/, '') === '/settings';
  const navRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLAnchorElement>(null);
  const lastSection = useRef<string | null>(null);
  useEffect(() => {
    if (!atIndex) lastSection.current = pathname;
    if (!narrow) return;
    // Only Back from a section returns focus to its link; the list's first render focuses nothing.
    if (atIndex) {
      const section = lastSection.current;
      if (section) [...(navRef.current?.querySelectorAll<HTMLAnchorElement>('a') ?? [])]
        .find(link => { const href = link.getAttribute('href') ?? ''; return section === href || section.startsWith(`${href}/`); })?.focus();
    } else backRef.current?.focus();
  }, [narrow, atIndex, pathname, instanceServerId]);

  if (!instanceServerId) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-text-muted">
        Connecting...
      </div>
    );
  }

  const groups: { heading: string; items: { to: string; label: string }[] }[] = [
    { heading: 'Who can do what', items: [
      { to: '/settings/roles', label: 'Roles' },
      { to: '/settings/role-assign', label: 'Role Assignment' },
      { to: '/settings/overrides', label: 'Channel Overrides' },
    ] },
    { heading: 'Agents and models', items: [
      { to: '/settings/agents', label: 'Agents' },
      { to: '/settings/models', label: 'Models and assistant' },
    ] },
  ];
  if (isAdmin) {
    groups.push({ heading: 'This server', items: [
      { to: '/settings/instance', label: 'Instance Settings' },
      { to: '/settings/storage', label: 'File Storage' },
    ] });
  }

  return (
    <div className="flex h-dvh w-full min-w-0 overflow-hidden bg-bg">
      {(!narrow || atIndex) && <aside className="w-full shrink-0 overflow-y-auto bg-surface border-r border-border flex flex-col sm:w-56">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-bold text-text">Server Settings</h1>
          <Link to="/app" className="min-h-11 md:min-h-8 inline-flex items-center text-text-muted text-sm hover:text-text">
            Back to chat
          </Link>
        </div>
        <nav ref={navRef} aria-label="Settings sections" className="flex flex-col p-2 gap-1">
          {groups.map(group => (
            <div key={group.heading} className="flex flex-col gap-1">
              <p className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-text-muted">{group.heading}</p>
          {group.items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `min-h-11 md:min-h-9 flex items-center px-3 py-2 rounded text-sm ${
                  isActive
                    ? 'bg-primary/20 text-text'
                    : 'text-text-muted hover:bg-surface-hover'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
            </div>
          ))}
        </nav>
      </aside>}
      {(!narrow || !atIndex) && <main aria-label="Settings section" className="min-w-0 flex-1 overflow-auto p-4 [overflow-wrap:anywhere] sm:p-6">
        {narrow && <Link ref={backRef} to="/settings" className="mb-3 inline-flex min-h-11 items-center gap-2 rounded px-2 text-sm text-primary-text hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
          <svg aria-hidden="true" className="h-4 w-4" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2"><path d="m12 4-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Back to settings
        </Link>}
        {children}
      </main>}
    </div>
  );
}
