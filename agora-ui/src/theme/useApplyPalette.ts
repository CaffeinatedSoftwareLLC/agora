import { useEffect } from 'react';
import { usePalette } from './usePalette';

/**
 * Push the chosen palette into the CSS variables Tailwind classes read. Called once at the
 * app root so every page (settings, login, moderation) follows the saved theme, not just
 * the chat shell.
 */
export function useApplyPalette() {
  const P = usePalette();
  useEffect(() => {
    const s = document.documentElement.style;
    s.setProperty('--color-bg', P.bg);
    s.setProperty('--color-surface', P.surface);
    s.setProperty('--color-surface-hover', P.surfaceHover);
    s.setProperty('--color-primary', P.primary);
    s.setProperty('--color-primary-hover', P.primaryHover);
    s.setProperty('--color-primary-text', P.primaryText);
    s.setProperty('--color-on-primary', P.onPrimary);
    s.setProperty('--color-accent', P.accent);
    s.setProperty('--color-on-accent', P.onAccent);
    s.setProperty('--color-secondary', P.secondary);
    s.setProperty('--color-text', P.text);
    s.setProperty('--color-white', P.white);
    s.setProperty('--color-text-muted', P.muted);
    s.setProperty('--color-text-dim', P.dim);
    s.setProperty('--color-border', P.border);
    s.setProperty('--color-online', P.online);
    s.setProperty('--color-danger', P.danger);
    s.setProperty('--color-warn', P.warn);
    document.body.style.background = P.bg;
    document.body.style.color = P.text;
  }, [P]);
}
