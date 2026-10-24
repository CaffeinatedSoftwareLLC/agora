import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Avatar } from './Avatar';
import { avatarColor, AVATAR_COLORS, resolveAvatarColors } from './avatarColors';
import { deltaE2000, hexToLab } from './avatarColorDistance.test-support';
import { PALETTES } from '../../theme/palettes';
import { useUIStore } from '../../stores/uiStore';

afterEach(cleanup);

it('distinguishes two senders with the same initial and keeps colour stable when a name changes', () => {
  const view = render(<><Avatar userId="sender-1" username="Claude" /><Avatar userId="sender-2" username="Codex" /></>);
  const claude = screen.getByRole('img', { name: 'Claude avatar' });
  const codex = screen.getByRole('img', { name: 'Codex avatar' });
  expect(claude.textContent).toBe('C'); expect(codex.textContent).toBe('C');
  expect(claude.style.backgroundColor).not.toBe(codex.style.backgroundColor);
  const before = claude.style.backgroundColor;
  view.rerender(<Avatar userId="sender-1" username="Clara" />);
  expect(screen.getByRole('img', { name: 'Clara avatar' }).style.backgroundColor).toBe(before);
  expect(avatarColor('sender-1 ')).toBe(avatarColor('sender-1'));
});

it('preserves a supplied avatar image', () => {
  render(<Avatar userId="sender-1" username="Claude" avatarUrl="data:image/png;base64,example" />);
  expect(screen.getByRole('img', { name: 'Claude' }).getAttribute('src')).toBe('data:image/png;base64,example');
});

it('keeps white initials at readable contrast across the entire theme-independent palette', () => {
  for (const hex of AVATAR_COLORS) {
    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    expect(1.05 / (luminance + 0.05), hex).toBeGreaterThanOrEqual(4.5);
  }
});

it('keeps every palette pair perceptually distinct (CIEDE2000 >= 20)', () => {
  // Sharma reference pairs guard the distance implementation itself.
  expect(deltaE2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
  expect(deltaE2000([50, 3.1571, -77.2803], [50, 0, -82.7485])).toBeCloseTo(2.8615, 4);
  for (let i = 0; i < AVATAR_COLORS.length; i++) for (let j = i + 1; j < AVATAR_COLORS.length; j++) {
    expect(deltaE2000(hexToLab(AVATAR_COLORS[i]), hexToLab(AVATAR_COLORS[j])), `${AVATAR_COLORS[i]} vs ${AVATAR_COLORS[j]}`)
      .toBeGreaterThanOrEqual(20);
  }
});

it('gives every default circle a neutral 2px boundary with >=3 contrast against both theme surfaces', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const key of ['aegean', 'terracotta'] as const) {
    useUIStore.setState({ paletteKey: key });
    const palette = PALETTES[key];
    const view = render(<Avatar userId="user" username="User" />);
    expect(view.getByRole('img').style.boxShadow).toBe(`inset 0 0 0 2px ${palette.text}`);
    for (const surface of [palette.bg, palette.surface, palette.surfaceHover]) {
      const [light, dark] = [luminance(palette.text), luminance(surface)].sort((a, b) => b - a);
      expect((light + 0.05) / (dark + 0.05), `${key} ${surface}`).toBeGreaterThanOrEqual(3);
    }
    view.unmount();
  }
});

it('probes hash collisions deterministically for eight bots regardless of input order', () => {
  const buckets = new Map<string, string[]>();
  for (let i = 0; i < 200; i++) {
    const id = `bot-${i}`;
    const bucket = buckets.get(avatarColor(id)) ?? [];
    bucket.push(id); buckets.set(avatarColor(id), bucket);
  }
  const ids = [...buckets.values()].find(bucket => bucket.length >= 8)!.slice(0, 8);
  const colors = resolveAvatarColors(ids);
  expect(new Set(colors.values()).size).toBe(8);
  expect(resolveAvatarColors([...ids].reverse())).toEqual(colors);
  expect(resolveAvatarColors([...ids, ids[0] + ' '])).toEqual(colors);
  expect(new Set(resolveAvatarColors(Array.from({ length: AVATAR_COLORS.length }, (_, i) => `user-${i}`)).values()).size).toBe(AVATAR_COLORS.length);
});
