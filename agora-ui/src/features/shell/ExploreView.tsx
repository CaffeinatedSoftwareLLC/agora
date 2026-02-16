import { useState } from 'react';
import { usePalette } from '../../theme';

// ─── Constants ──────────────────────────────────────────────────────────────

const CATEGORIES = ['Popular', 'Technology', 'Education', 'Gaming', 'Science', 'Art'] as const;

// ─── Component ──────────────────────────────────────────────────────────────

export function ExploreView() {
  const P = usePalette();

  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string | null>(null);

  return (
    <>
      {/* Search bar */}
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl mb-5 transition-all"
        style={{ background: P.surface, border: `1px solid ${P.border}` }}
      >
        <svg
          className="h-4 w-4 shrink-0"
          style={{ color: P.dim }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search public servers..."
          className="flex-1 bg-transparent text-[14px] outline-none min-w-0"
          style={{ color: P.text, caretColor: P.accent }}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            className="p-1 rounded-md transition-colors"
            style={{ color: P.dim }}
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      {/* Category pills */}
      <div className="flex gap-2 mb-5 flex-wrap">
        {CATEGORIES.map(cat => {
          const isActive = activeCategory === cat;
          return (
            <button
              key={cat}
              onClick={() => setActiveCategory(isActive ? null : cat)}
              className="px-3 py-1.5 rounded-full text-[11px] font-medium cursor-pointer transition-all"
              style={{
                background: isActive ? P.accent : P.surface,
                color: isActive ? P.bg : P.muted,
                border: `1px solid ${isActive ? P.accent : P.border}`,
              }}
            >
              {cat}
            </button>
          );
        })}
      </div>

      {/* Empty state */}
      <div className="flex flex-col items-center justify-center py-16">
        {/* Compass icon */}
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
          style={{ background: P.surface }}
        >
          <svg
            className="h-8 w-8"
            style={{ color: P.dim }}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="12" cy="12" r="10" />
            <polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76" />
          </svg>
        </div>
        <h3 className="text-[16px] font-semibold mb-1" style={{ color: P.text }}>
          Server discovery coming soon
        </h3>
        <p className="text-[13px] max-w-[360px] text-center" style={{ color: P.muted }}>
          Explore and join public servers created by the community. This feature is currently under development.
        </p>
      </div>
    </>
  );
}
