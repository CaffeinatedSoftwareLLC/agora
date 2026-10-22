import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Avatar, avatarColor, AVATAR_COLORS } from './Avatar';

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
