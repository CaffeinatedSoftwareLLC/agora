import type { ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useServerStore } from '../../stores/serverStore';
import { useAuthStore } from '../../stores/authStore';

export function ServerSettingsLayout({ children }: { children: ReactNode }) {
  const instanceServerId = useServerStore(s => s.instanceServerId);
  const isAdmin = useAuthStore(s => s.user?.isInstanceAdmin) === true;

  if (!instanceServerId) {
    return (
      <div className="flex h-screen items-center justify-center bg-bg text-text-muted">
        Connecting...
      </div>
    );
  }

  const navItems: { to: string; label: string; end: boolean }[] = [
    { to: '/settings/roles', label: 'Roles', end: false },
    { to: '/settings/role-assign', label: 'Role Assignment', end: false },
    { to: '/settings/overrides', label: 'Channel Overrides', end: false },
    { to: '/settings/bots', label: 'Bots', end: false },
    { to: '/settings/ai', label: 'AI Assistant', end: false },
  ];

  if (isAdmin) {
    navItems.push(
      { to: '/settings/instance', label: 'Instance Settings', end: false },
      { to: '/settings/storage', label: 'File Storage', end: false },
    );
  }

  return (
    <div className="flex h-screen bg-bg">
      <aside className="w-56 bg-surface border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-bold text-text">Server Settings</h1>
          <Link to="/app" className="text-text-muted text-sm hover:text-text">
            Back to chat
          </Link>
        </div>
        <nav className="flex flex-col p-2 gap-1">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `px-3 py-2 rounded text-sm ${
                  isActive
                    ? 'bg-primary/20 text-text'
                    : 'text-text-muted hover:bg-surface-hover'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}
