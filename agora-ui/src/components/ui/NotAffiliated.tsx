/**
 * The not-affiliated line (docs/provider-terms.md, "Branding"). Agora runs the official CLIs
 * by name only; it is not made or endorsed by their vendors.
 */
export const NOT_AFFILIATED =
  'Agora is not affiliated with Anthropic, OpenAI or Google. Claude Code, Codex and Gemini are trademarks of their owners.';

export function NotAffiliated({ className = '' }: { className?: string }) {
  return <p className={`text-center text-xs text-text-muted ${className}`}>{NOT_AFFILIATED}</p>;
}
