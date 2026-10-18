import { useState, useMemo, useEffect, useCallback, useRef, type KeyboardEvent } from 'react';
import { useMemberStore } from '../../stores/memberStore';

interface MentionAutocompleteProps {
  query: string;
  serverId: string | null;
  onSelect: (username: string) => void;
  onClose: () => void;
  visible: boolean;
}

function MentionAutocompleteInner({ query, serverId, onSelect, onClose }: Omit<MentionAutocompleteProps, 'visible'>) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const selectedRef = useRef(0);
  useEffect(() => { selectedRef.current = selectedIndex; }, [selectedIndex]);
  const members = useMemberStore((s) => (serverId ? s.byServer.get(serverId) : null));
  const loadMembers = useMemberStore((s) => s.loadMembers);

  // Lazy-load members if not already in store
  useEffect(() => {
    if (serverId && !members) {
      loadMembers(serverId);
    }
  }, [serverId, members, loadMembers]);

  const filtered = useMemo(
    () =>
      members
        ?.filter((m) => m.username.toLowerCase().startsWith(query.toLowerCase()))
        .slice(0, 5) ?? [],
    [members, query],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (filtered.length === 0) return;
      // This runs in the document capture phase, before the composer's own
      // onKeyDown. preventDefault marks the key as handled and stopPropagation
      // keeps it from reaching the composer, so Enter selects without sending.
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        e.stopPropagation();
        const member = filtered[Math.min(selectedRef.current, filtered.length - 1)];
        if (member) onSelect(member.username);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    },
    [filtered, onSelect, onClose],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      handleKeyDown(e as unknown as KeyboardEvent);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [handleKeyDown]);

  if (filtered.length === 0) return null;

  return (
    <div className="absolute bottom-full mb-1 left-0 right-0 bg-surface border border-border rounded-lg shadow-lg overflow-hidden z-50">
      {filtered.map((member, i) => (
        <button
          key={member.id}
          onClick={() => onSelect(member.username)}
          className={`w-full min-h-11 md:min-h-9 px-3 py-2 flex items-center gap-2 text-[13px] text-left transition-colors ${
            i === selectedIndex ? 'bg-surface-hover text-text' : 'text-text-muted hover:bg-surface-hover/50'
          }`}
        >
          <span className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-[11px] font-bold text-on-primary shrink-0">
            {member.username[0].toUpperCase()}
          </span>
          <span className="font-medium">{member.username}</span>
        </button>
      ))}
    </div>
  );
}

export function MentionAutocomplete({ visible, query, ...rest }: MentionAutocompleteProps) {
  // Using `key={query}` resets selectedIndex to 0 whenever query changes
  if (!visible) return null;
  return <MentionAutocompleteInner key={query} query={query} {...rest} />;
}
