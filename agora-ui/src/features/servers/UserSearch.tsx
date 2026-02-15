import { useState, useEffect, useRef } from 'react';
import { userApi } from '../../lib/api';
import type { UserSearchResult } from '../../lib/contracts/server';

interface UserSearchProps {
  onSelect: (user: UserSearchResult) => void;
}

export function UserSearch({ onSelect }: UserSearchProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<UserSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);

    if (query.trim().length < 2) {
      setResults([]);
      return;
    }

    timerRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const users = await userApi.searchUsers(query.trim());
        setResults(users);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [query]);

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by username..."
        className="w-full bg-bg border border-border rounded px-3 py-2 text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary"
      />
      {loading && (
        <p className="text-text-muted text-sm mt-2">Searching...</p>
      )}
      {results.length > 0 && (
        <div className="mt-2 border border-border rounded bg-bg max-h-48 overflow-y-auto">
          {results.map((user) => (
            <button
              key={user.id}
              onClick={() => {
                onSelect(user);
                setQuery('');
                setResults([]);
              }}
              className="w-full px-3 py-2 text-left text-text hover:bg-surface-hover flex items-center gap-2 transition-colors"
            >
              <div className="w-7 h-7 rounded-full bg-primary flex items-center justify-center text-xs font-bold text-white shrink-0">
                {user.username[0].toUpperCase()}
              </div>
              <span className="text-sm">{user.username}</span>
            </button>
          ))}
        </div>
      )}
      {!loading && query.trim().length >= 2 && results.length === 0 && (
        <p className="text-text-dim text-sm mt-2">No users found</p>
      )}
    </div>
  );
}
