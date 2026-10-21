import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSocket } from '../../hooks/useSocket';
import type { AgentSessionUpdatePayload } from '../../lib/contracts/ws-events';
import { useChannelStore } from '../../stores/channelStore';
import { useMessageStore } from '../../stores/messageStore';
import { useThreadStore } from '../../stores/threadStore';
import { useAgentPresenceStore } from '../../stores/agentPresenceStore';
import { ProtocolBadge } from '../messages/ProtocolBadge';
import { latestProtocol } from '../messages/latestProtocol';
import {
  OWN_SESSION_LABEL, STATE_LABEL, compactTokens, deriveChips, listProfiles, listSessions, ownSessionChips, ownSessionDetail, resetTime,
  type AgentProfile, type AgentSession, type OwnSessionStatus,
} from './agentSessions';
import { SessionSheet, StateDot, type SheetMode } from './SessionSheet';
import { ChannelAgentsControl } from './ChannelAgents';

/**
 * Console Strip (docs/planning/ui-redesign.md 6.2): one horizontally scrolling row under the
 * channel header with a chip per agent in this channel (live first), a "+ Agent" chip, and a
 * chip per active agora-collab thread. Agent chips open the Session Sheet; thread chips call
 * onOpenThread. Sessions refresh on channel change, on every agent_session notice in the
 * channel, and every 20 seconds while the page is visible.
 */

interface ConsoleStripProps {
  channelId: string;
  onOpenThread: (threadId: string) => void;
}

const POLL_MS = 20_000;
const NO_SESSIONS: AgentSession[] = [];

// The pill is 32px tall, centered in a 44px touch target.
const CHIP_TARGET = 'group flex min-h-[44px] shrink-0 items-center rounded-full focus-visible:outline-none';
const CHIP_PILL = 'flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-surface-hover px-3 text-[13px] text-text transition-colors group-hover:bg-bg group-focus-visible:outline-2 group-focus-visible:outline-offset-1 group-focus-visible:outline-accent';

export function ConsoleStrip({ channelId, onOpenThread }: ConsoleStripProps) {
  const socket = useSocket();
  const serverId = useChannelStore(s => s.channels.get(channelId)?.serverId ?? null);
  const [loaded, setLoaded] = useState<{ channelId: string; sessions: AgentSession[] }>({ channelId, sessions: [] });
  const [sheetState, setSheet] = useState<{ mode: SheetMode; key: number; channelId: string } | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[] | null>(null);
  const [profilesError, setProfilesError] = useState('');
  const channelRef = useRef(channelId);
  useEffect(() => { channelRef.current = channelId; }, [channelId]);

  // Another channel's chips and sheet never show here, even before this channel loads.
  const sessions = loaded.channelId === channelId ? loaded.sessions : NO_SESSIONS;
  const sheet = sheetState?.channelId === channelId ? sheetState : null;

  const refresh = useCallback(() => {
    const forChannel = channelId;
    listSessions(forChannel)
      .then(list => { if (channelRef.current === forChannel) setLoaded({ channelId: forChannel, sessions: list }); })
      .catch(() => { /* keep the last good list; the next poll or notice retries */ });
  }, [channelId]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (!socket) return;
    const onSessionUpdate = (event: AgentSessionUpdatePayload) => {
      if (event.channelId === channelId) refresh();
    };
    socket.on('AgentSessionUpdate', onSessionUpdate);
    return () => { socket.off('AgentSessionUpdate', onSessionUpdate); };
  }, [socket, channelId, refresh]);

  // Poll while visible; catch up as soon as the page is shown again.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(() => { refresh(); }, POLL_MS);
    };
    const stop = () => {
      if (timer !== null) { clearInterval(timer); timer = null; }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') { refresh(); start(); } else stop();
    };
    if (document.visibilityState === 'visible') start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [refresh]);

  // Every session change posts an agent_session notice into the channel.
  const channelMessages = useMessageStore(s => s.byChannel.get(channelId));
  const lastNoticeId = useMemo(() => {
    if (!channelMessages) return undefined;
    for (let i = channelMessages.length - 1; i >= 0; i--) {
      if (channelMessages[i].systemEvent === 'agent_session') return channelMessages[i].id;
    }
    return undefined;
  }, [channelMessages]);
  // The first notice seen in a channel is history (the channel load already fetched); a later one is news.
  const seenNotice = useRef<{ channelId: string; id: string | undefined } | null>(null);
  useEffect(() => {
    const seen = seenNotice.current;
    seenNotice.current = { channelId, id: lastNoticeId };
    if (seen && seen.channelId === channelId && seen.id !== lastNoticeId && lastNoticeId !== undefined) refresh();
  }, [channelId, lastNoticeId, refresh]);

  // Active collab threads (the data ActiveThreadsBar uses).
  const activeThreads = useThreadStore(s => s.activeThreads.get(channelId));
  const repliesByThread = useThreadStore(s => s.repliesByThread);
  const loadActiveThreads = useThreadStore(s => s.loadActiveThreads);
  useEffect(() => { void loadActiveThreads(channelId).catch(() => {}); }, [channelId, loadActiveThreads]);

  const threads = useMemo(() => (activeThreads ?? []).filter(t => !t.threadClosedAt).map(t => {
    const parent = channelMessages?.find(m => m.id === t.id);
    const cached = [...(parent ? [parent] : []), ...(repliesByThread.get(t.id) ?? [])]
      .filter(m => !t.latestProtocol || m.id >= t.latestProtocol.messageId)
      .sort((a, b) => a.id.localeCompare(b.id));
    const protocol = latestProtocol(cached) ?? t.latestProtocol ?? undefined;
    return { thread: t, protocol };
  }), [activeThreads, channelMessages, repliesByThread]);

  const chips = useMemo(() => deriveChips(sessions), [sessions]);
  const present = useAgentPresenceStore(s => s.byChannel.get(channelId));
  const ownChips = useMemo(() => ownSessionChips(present?.values() ?? [], sessions), [present, sessions]);

  const openStart = () => {
    setSheet({ mode: { kind: 'start' }, key: Date.now(), channelId });
    if (!serverId) { setProfilesError('Could not find this channel\'s server.'); return; }
    setProfilesError('');
    listProfiles(serverId)
      .then(setProfiles)
      .catch(() => setProfilesError('Could not load the agents on this server.'));
  };

  return (
    <div
      role="toolbar"
      aria-label="Agents and active threads"
      className="flex min-h-[44px] w-full min-w-0 max-w-full shrink-0 items-center gap-2 overflow-x-auto border-b border-border bg-surface/60 px-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {chips.map(chip => {
        const tokens = chip.session.state !== 'ended' && chip.session.tokensUsed > 0 ? compactTokens(chip.session.tokensUsed) : null;
        // A rate-limited agent says so on the chip, with the reset time (#147)
        const resets = chip.state === 'sleeping' && chip.session.sleepingUntil ? resetTime(chip.session.sleepingUntil) : null;
        return (
          <button
            key={chip.profile}
            type="button"
            className={CHIP_TARGET}
            aria-haspopup="dialog"
            aria-label={`${chip.profile}: ${STATE_LABEL[chip.state].toLowerCase()}${resets ? `, resets ${resets}` : ''}${tokens ? `, ${tokens} tokens` : ''}. Open session controls`}
            onClick={() => setSheet({ mode: { kind: 'profile', profile: chip.profile }, key: Date.now(), channelId })}
          >
            <span className={CHIP_PILL}>
              <StateDot state={chip.state} />
              <span className="font-medium">{chip.profile}</span>
              {resets && <span className="text-xs text-text-muted">Sleeping · <span className="hidden sm:inline">resets </span>{resets}</span>}
              {tokens && <span className="font-mono text-xs text-text-muted">{tokens}</span>}
            </span>
          </button>
        );
      })}

      {ownChips.map(chip => {
        const working = !!chip.session?.running && chip.status !== 'offline';
        const label = working ? 'working' : chip.status === 'listening' ? 'listening' : chip.status === 'connected' ? 'connected' : 'offline';
        const pill = (
          <span className={`${CHIP_PILL} border-dashed`}>
            <OwnSessionDot status={chip.status} working={working} />
            <span className="font-medium">{chip.username}</span>
            <span className="text-xs text-text-muted">{chip.session ? `terminal · ${label}` : label}</span>
          </span>
        );
        // With a terminal session (#112) the chip opens its sheet; without one it is presence only
        return chip.session ? (
          <button
            key={`own-${chip.userId}`}
            type="button"
            className={CHIP_TARGET}
            aria-haspopup="dialog"
            title={`${OWN_SESSION_LABEL[chip.status]}. ${ownSessionDetail(chip)}`}
            aria-label={`${chip.username}: terminal session, ${label}. Open session details`}
            data-testid="own-session-chip"
            onClick={() => setSheet({ mode: { kind: 'terminal', botId: chip.userId }, key: Date.now(), channelId })}
          >
            {pill}
          </button>
        ) : (
          <span
            key={`own-${chip.userId}`}
            role="img"
            className={`${CHIP_TARGET} cursor-default`}
            title={`${OWN_SESSION_LABEL[chip.status]}. ${ownSessionDetail(chip)}`}
            aria-label={`${chip.username}: ${OWN_SESSION_LABEL[chip.status].toLowerCase()}`}
            data-testid="own-session-chip"
          >
            {pill}
          </span>
        );
      })}

      <ChannelAgentsControl key={channelId} channelId={channelId} serverId={serverId} />
      <button type="button" className={CHIP_TARGET} aria-haspopup="dialog" aria-label="Start an agent" onClick={openStart}>
        <span className={`${CHIP_PILL} border-dashed text-text-muted group-hover:text-text`}>+ Agent</span>
      </button>

      {threads.length > 0 && <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" />}

      {threads.map(({ thread, protocol }) => {
        const snippet = thread.content ? thread.content.replace(/\s+/g, ' ').trim() : '(deleted)';
        return (
          <button
            key={thread.id}
            type="button"
            className={CHIP_TARGET}
            title={snippet}
            aria-label={`Open thread${protocol ? ` (${protocol.state}${protocol.yieldTo ? `, next: ${protocol.yieldTo}` : ''})` : ''}: ${snippet.slice(0, 80)}, ${thread.replyCount} ${thread.replyCount === 1 ? 'reply' : 'replies'}`}
            onClick={() => onOpenThread(thread.id)}
          >
            <span className={CHIP_PILL}>
              <svg className="h-3.5 w-3.5 shrink-0 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
              </svg>
              {protocol && <ProtocolBadge protocol={{ ...protocol, yieldTo: undefined }} />}
              {protocol?.yieldTo && <span className="text-xs text-text-muted">→ {protocol.yieldTo}</span>}
              <span className="max-w-[10rem] truncate">{snippet}</span>
              <span className="font-mono text-xs text-text-muted">{thread.replyCount}</span>
            </span>
          </button>
        );
      })}

      {sheet && (
        <SessionSheet
          key={sheet.key}
          open
          onClose={() => setSheet(null)}
          channelId={channelId}
          mode={sheet.mode}
          sessions={sessions}
          profiles={profiles}
          profilesError={profilesError}
          onChanged={() => { refresh(); }}
        />
      )}
    </div>
  );
}

/** A ring, not a filled dot, so a user's own session never reads as a hosted one. */
function OwnSessionDot({ status, working = false }: { status: OwnSessionStatus; working?: boolean }) {
  const tone = working ? 'border-online bg-online motion-safe:animate-pulse' : status === 'listening' ? 'border-online bg-online/40 motion-safe:animate-pulse' : status === 'connected' ? 'border-online' : 'border-text-dim';
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full border-2 ${tone}`} />;
}
