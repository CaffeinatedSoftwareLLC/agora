import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { boxApi, type Box, type TerminalSession, type TerminalStatus } from '../api';
import { TerminalControls } from './TerminalControls';

const ID = 'B'.repeat(26);
const box = (over: Partial<Box> = {}): Box => ({
  id: ID, name: 'builder', adapter: 'claude', auth: 'subscription', state: 'running', desiredState: 'running', pendingAction: null,
  generation: 2, imageVersion: 6, loginState: 'logged_in', homeChannelId: 'C1', allowedDomains: [], repos: [], cpus: 2,
  memoryMb: 4096, pids: 1024, lastError: null, lastSeenAt: null, createdAt: '', deletedAt: null, volumePurgeAfter: null, policies: [],
  terminalIdleMinutes: 15, terminalMaxHours: 8, terminalRateKbps: 512, ...over,
});
const status = (over: Partial<TerminalStatus> = {}): TerminalStatus => ({
  box: { id: ID, name: 'builder', adapter: 'claude' }, supported: true, hostConnected: true, running: true, open: null, activeRun: false,
  limits: { idleMinutes: 15, maxHours: 8, rateKbps: 512 }, ...over,
});
const session = (over: Partial<TerminalSession> = {}): TerminalSession => ({
  id: 'S1', openedByName: 'eryk', state: 'closed', openedAt: '2026-11-13T10:00:00Z', startedAt: '2026-11-13T10:00:01Z', closedAt: '2026-11-13T10:12:01Z',
  closeReason: 'idle_timeout', durationSeconds: 720, bytesIn: 120, bytesOut: 20480, ...over,
});

let getStatus: ReturnType<typeof vi.spyOn>;
let update: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  getStatus = vi.spyOn(boxApi, 'terminalStatus').mockResolvedValue(status());
  vi.spyOn(boxApi, 'terminalSessions').mockResolvedValue({ sessions: [] });
  update = vi.spyOn(boxApi, 'update').mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('opens the terminal page in a new tab, with no opener', async () => {
  const open = vi.spyOn(window, 'open').mockImplementation(() => null);
  render(<TerminalControls box={box()} onChange={vi.fn()} />);
  const button = await screen.findByTestId('open-terminal');
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(open).toHaveBeenCalledWith(`/terminal/${ID}`, '_blank', 'noopener,noreferrer');
});

it('a box that needs its update says so instead of hanging', async () => {
  getStatus.mockResolvedValue(status({ supported: false, hostConnected: false }));
  render(<TerminalControls box={box()} onChange={vi.fn()} />);
  expect(await screen.findByTestId('terminal-hint')).toHaveTextContent('needs its update first');
  expect(screen.getByTestId('open-terminal')).toBeDisabled();
});

it('a box that is not connected, and a stopped box, are not offered a terminal', async () => {
  getStatus.mockResolvedValue(status({ hostConnected: false }));
  render(<TerminalControls box={box()} onChange={vi.fn()} />);
  expect(await screen.findByTestId('terminal-hint')).toHaveTextContent('not connected');
  cleanup();
  getStatus.mockResolvedValue(status({ running: false }));
  render(<TerminalControls box={box({ state: 'stopped' })} onChange={vi.fn()} />);
  expect(await screen.findByTestId('terminal-hint')).toHaveTextContent('not running');
  expect(screen.getByTestId('open-terminal')).toBeDisabled();
});

it('shows who has a terminal open', async () => {
  getStatus.mockResolvedValue(status({ open: { id: 'S', openedByName: 'eryk', openedAt: '2026-11-13T10:00:00Z', mine: true } }));
  render(<TerminalControls box={box()} onChange={vi.fn()} />);
  expect(await screen.findByTestId('terminal-open-now')).toHaveTextContent('A terminal is open (eryk)');
});

it('the limits are shown, changeable and checked before saving', async () => {
  const onChange = vi.fn();
  render(<TerminalControls box={box()} onChange={onChange} />);
  await screen.findByTestId('open-terminal');
  const idle = screen.getByLabelText(/without a keystroke/) as HTMLInputElement;
  const rate = screen.getByLabelText(/Most output/) as HTMLInputElement;
  expect(idle.value).toBe('15');
  expect(screen.getByLabelText(/longer than this many hours/)).toHaveValue('8');
  expect(rate.value).toBe('512');
  const save = screen.getByRole('button', { name: 'Save limits' });
  expect(save).toBeDisabled();
  fireEvent.change(idle, { target: { value: '0' } });
  expect(save).toBeDisabled();
  fireEvent.change(idle, { target: { value: '30' } });
  fireEvent.change(rate, { target: { value: '9000' } });
  expect(save).toBeDisabled();
  fireEvent.change(rate, { target: { value: '256' } });
  fireEvent.click(save);
  await waitFor(() => expect(update).toHaveBeenCalledWith(ID, { terminalIdleMinutes: 30, terminalRateKbps: 256 }));
  await waitFor(() => expect(onChange).toHaveBeenCalled());
});

it('lists the record of earlier terminals: who, when, how long, how much, why it ended', async () => {
  vi.spyOn(boxApi, 'terminalSessions').mockResolvedValue({ sessions: [session(), session({ id: 'S2', state: 'open', closedAt: null, closeReason: null, durationSeconds: null, openedByName: 'ana' })] });
  render(<TerminalControls box={box()} onChange={vi.fn()} />);
  const list = await screen.findByTestId('terminal-history');
  expect(list.children).toHaveLength(2);
  expect(list.children[0]).toHaveTextContent('eryk · 12m · 120 B typed, 20.0 KiB printed · It closed because nothing was typed for the idle limit.');
  expect(list.children[1]).toHaveTextContent('ana');
  expect(list.children[1]).toHaveTextContent('open now');
});
