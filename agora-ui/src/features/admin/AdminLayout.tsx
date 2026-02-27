import type { ReactNode } from 'react';
import { NavLink, Link } from 'react-router-dom';

const navItems = [
  { to: '/admin', label: 'Dashboard', end: true },
  { to: '/admin/pending', label: 'Pending Users', end: false },
  { to: '/admin/users', label: 'All Users', end: false },
  { to: '/admin/settings', label: 'Settings', end: false },
  { to: '/admin/storage', label: 'File Storage', end: false },
];

export function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen">
      <aside className="w-56 bg-surface border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-bold">Instance Settings</h1>
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
