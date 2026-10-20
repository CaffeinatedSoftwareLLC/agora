import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NOT_AFFILIATED } from './NotAffiliated';
import { SetupWizard } from '../../features/setup/SetupWizard';
import { AgentSessionsSettings } from '../../features/settings/AgentSessionsSettings';
import { api, serverApi } from '../../lib/api';
import { useServerStore } from '../../stores/serverStore';

/**
 * beta-test-plan §6.1 Branding (docs/provider-terms.md): providers are named in plain text,
 * every page that names them carries the not-affiliated line, and the UI ships no logos.
 */

// vitest runs from agora-ui/ (its config lives there); jsdom's import.meta.url is not a file URL
const UI_ROOT = existsSync(join(process.cwd(), 'vitest.setup.ts')) ? process.cwd() : join(process.cwd(), 'agora-ui');
const IMAGE = /\.(png|jpe?g|gif|svg|webp|ico|avif|bmp)$/i;
const PROVIDER = /anthropic|openai|claude|gemini|google|chatgpt|codex/i;

function images(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...images(path));
    else if (IMAGE.test(name)) out.push(path.slice(UI_ROOT.length).replace(/\\/g, '/'));
  }
  return out;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('not-affiliated line', () => {
  test('names the vendors in plain text', () => {
    expect(NOT_AFFILIATED).toBe('Agora is not affiliated with Anthropic, OpenAI or Google. Claude Code, Codex and Gemini are trademarks of their owners.');
  });

  test('shows on the setup wizard', () => {
    render(<SetupWizard onComplete={() => {}} />);
    expect(screen.getByText(NOT_AFFILIATED)).toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  test('shows on Settings → Agents', async () => {
    useServerStore.setState({ instanceServerId: 'S'.repeat(26) });
    vi.spyOn(api, 'get').mockResolvedValue([]);
    vi.spyOn(serverApi, 'getChannels').mockResolvedValue([]);
    render(<AgentSessionsSettings />);
    expect(await screen.findByText(NOT_AFFILIATED)).toBeInTheDocument();
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});

describe('no provider logos', () => {
  test('no image under public/ or src/ is named for a provider', () => {
    const all = [...images(join(UI_ROOT, 'public')), ...images(join(UI_ROOT, 'src'))];
    expect(all.length).toBeGreaterThan(0); // the scan saw the tree (public/vite.svg)
    expect(all.filter(f => PROVIDER.test(f))).toEqual([]);
  });
});
