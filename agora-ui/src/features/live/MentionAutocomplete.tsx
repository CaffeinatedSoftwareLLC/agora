import { useState, useMemo, useEffect, useCallback, type KeyboardEvent } from 'react';
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
  const members = useMemberStore((s) => (serverId ? s.byServer.get(serverId) : null));

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
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        setSelectedIndex((cur) => {
          onSelect(filtered[cur].username);
          return cur;
        });
      } else if (e.key === 'Escape') {
        e.preventDefault();
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
          className={`w-full px-3 py-2 flex items-center gap-2 text-sm text-left transition-colors ${
            i === selectedIndex ? 'bg-surface-hover text-text' : 'text-text-muted hover:bg-surface-hover/50'
          }`}
        >
          <span className="w-6 h-6 rounded-full bg-primary flex items-center justify-center text-xs font-bold text-white shrink-0">
            {member.username[0].toUpperCase()}
          </span>
          <span>{member.username}</span>
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
