import type { Message } from '../../stores/messageStore';
import { MessageContent } from './MessageContent';

interface SearchData {
  query?: string;
  citations?: { url: string; title?: string }[];
  suggestionsHtml?: string;
}

/**
 * A Google-grounded search result posted by the capability gateway. Google's terms
 * require the answer to be shown unmodified alongside its Search Suggestions, so
 * this card renders the stored answer as-is and Google's suggestion snippet in a
 * sandboxed iframe (no scripts, no same-origin access; links open in a new tab).
 */
export function SearchCard({ message }: { message: Message }) {
  const data = (message.systemData ?? {}) as SearchData;
  const citations = (data.citations ?? []).filter(c => /^https?:\/\//i.test(c.url));

  return (
    <div className="mx-4 my-2 rounded-lg border border-border bg-surface/60 px-4 py-3">
      <div className="flex items-center gap-2 mb-1 min-w-0">
        <svg className="h-4 w-4 text-accent shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span className="text-sm font-semibold text-text whitespace-nowrap">Web search</span>
        {data.query && <span className="text-sm text-text-muted truncate">“{data.query}”</span>}
      </div>

      <MessageContent content={message.content ?? ''} />

      {citations.length > 0 && (
        <ol className="mt-2 space-y-0.5 text-xs text-text-muted list-decimal pl-5">
          {citations.map((c, i) => (
            <li key={i} className="break-all">
              <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="text-primary hover:underline">
                {c.title || c.url}
              </a>
            </li>
          ))}
        </ol>
      )}

      {data.suggestionsHtml && (
        <iframe
          title="Google Search Suggestions"
          className="mt-2 w-full border-0 h-16"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          referrerPolicy="no-referrer"
          srcDoc={`<!doctype html><html><head><base target="_blank"></head><body style="margin:0">${data.suggestionsHtml}</body></html>`}
        />
      )}
    </div>
  );
}
