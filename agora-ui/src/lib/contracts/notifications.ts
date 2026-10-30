/** Notification types the server sends (src/lib/notifications.ts). */
export type NotificationType = 'approval' | 'mention' | 'session' | 'review' | 'collab';

export const NOTIFICATION_TYPES: { type: NotificationType; label: string; description: string }[] = [
  { type: 'approval', label: 'Approvals', description: 'A run, tool or permission approval is waiting for you.' },
  { type: 'mention', label: 'Mentions', description: 'Someone @mentioned you.' },
  { type: 'session', label: 'Agent sessions', description: 'An agent session you started is blocked, out of budget or at its usage limit.' },
  { type: 'review', label: 'Task review', description: 'A task card you created moved to Review.' },
  { type: 'collab', label: 'Collaboration', description: 'Agents finished or blocked a collaboration in a thread you started.' },
];

/** One notification. `label` is a short description, never message text; `url` is a UI path. */
export interface AppNotification {
  id: string;
  type: NotificationType;
  label: string;
  url: string;
  serverId: string | null;
  channelId: string | null;
  threadId: string | null;
  readAt: string | null;
  createdAt: string;
}

export interface NotificationPage {
  notifications: AppNotification[];
  unread: number;
  hasMore: boolean;
}

/** NotificationRead socket event: some or all of the user's notifications were read elsewhere. */
export interface NotificationReadPayload {
  ids?: string[];
  all?: boolean;
  unread: number;
}

export interface NotificationPreferences {
  types: Record<NotificationType, boolean>;
  appPush: boolean;
}

export interface PushDevice {
  id: string;
  relay: string;
  platform: 'android' | 'ios';
  label: string;
  createdAt: string;
  lastOkAt: string | null;
}

/** What the native app's registerPush() resolves to (docs/planning/mobile-apps.md section 8). */
export interface NativePushRegistration {
  relay: string;
  handle: string;
  platform: 'android' | 'ios';
  label: string;
}

/** Exposed by the Android and iOS apps on `window` when the UI runs inside them. */
export interface AgoraNative {
  platform: 'android' | 'ios';
  version: string;
  /** Asks for notification permission if needed, registers with the relay, resolves null if denied. */
  registerPush(): Promise<NativePushRegistration | null>;
  unregisterPush(handle: string): Promise<void>;
}

declare global {
  interface Window {
    AgoraNative?: AgoraNative;
  }
}
