import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useNotificationStore } from '../../stores/notificationStore';
import { relativeTime } from '../../lib/relativeTime';
import type { AppNotification } from '../../lib/contracts/notifications';

/**
 * The notification bell: unread badge and, when opened, the list. Tapping a notification
 * marks it read and opens its channel (and thread). On a phone the list spans the screen
 * width under the header; on wider screens it drops down from the bell.
 */
export function NotificationBell({ className = '' }: { className?: string }) {
  const navigate = useNavigate();
  const items = useNotificationStore(s => s.items);
  const unread = useNotificationStore(s => s.unread);
  const hasMore = useNotificationStore(s => s.hasMore);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  useEffect(() => {
    if (!open) return;
    useNotificationStore.getState().load().catch(() => setError("Couldn't load notifications."));
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  const select = (n: AppNotification) => {
    setOpen(false);
    void useNotificationStore.getState().markRead(n.id).catch(() => {});
    // Only paths inside this UI: the server builds them, but never follow anything else
    if (n.url.startsWith('/') && !n.url.startsWith('//')) navigate(n.url);
  };

  const badge = unread > 99 ? '99+' : String(unread);
  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => { setError(''); setOpen(o => !o); }}
        className="relative min-h-11 min-w-11 md:min-h-8 md:min-w-8 rounded-full flex items-center justify-center text-text-muted hover:bg-surface-hover hover:text-text transition-colors"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {unread > 0 && (
          <span
            className="absolute top-1 right-1 md:-top-0.5 md:-right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-danger text-white text-[11px] font-semibold leading-[18px] text-center"
            aria-hidden="true"
          >
            {badge}
          </span>
        )}
      </button>

      {open && (
        <div
          id={listId}
          role="dialog"
          aria-label="Notifications"
          className="fixed left-2 right-2 top-14 md:absolute md:left-auto md:right-0 md:top-full md:mt-2 md:w-[360px] z-50 max-h-[70vh] flex flex-col rounded-xl border border-border bg-surface shadow-xl"
        >
          <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-border">
            <h2 className="text-sm font-semibold text-text">Notifications</h2>
            <button
              type="button"
              disabled={unread === 0}
              onClick={() => { void useNotificationStore.getState().markAllRead().catch(() => {}); }}
              className="min-h-11 md:min-h-8 px-2 text-[13px] text-accent hover:underline disabled:opacity-40 disabled:no-underline"
            >
              Mark all read
            </button>
          </div>
          {error && <p className="px-4 py-3 text-sm text-danger" role="alert">{error}</p>}
          {!error && items.length === 0 && <p className="px-4 py-6 text-sm text-text-muted text-center">No notifications yet.</p>}
          {items.length > 0 && (
            <ul className="overflow-y-auto" aria-label="Notification list">
              {items.map(n => (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => select(n)}
                    className={`w-full text-left min-h-11 px-4 py-2.5 flex items-start gap-3 hover:bg-surface-hover border-b border-border/50 ${n.readAt ? 'opacity-70' : ''}`}
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.readAt ? 'bg-transparent' : 'bg-accent'}`}
                      aria-label={n.readAt ? undefined : 'Unread'}
                      role={n.readAt ? undefined : 'img'}
                    />
                    <span className="flex-1 min-w-0">
                      <span className={`block text-[14px] break-words ${n.readAt ? 'text-text-muted' : 'text-text font-medium'}`}>{n.label}</span>
                      <span className="block text-[12px] text-text-muted">{relativeTime(n.createdAt)}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {hasMore && (
            <button
              type="button"
              onClick={() => { void useNotificationStore.getState().loadMore().catch(() => setError("Couldn't load notifications.")); }}
              className="min-h-11 md:min-h-9 text-[13px] text-accent hover:underline"
            >
              Show older
            </button>
          )}
        </div>
      )}
    </div>
  );
}
