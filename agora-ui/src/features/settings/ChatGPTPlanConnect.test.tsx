import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { ChatGPTPlanConnect, USAGE_URL, type PlanConnection } from './ChatGPTPlanConnect';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const post = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => ({ ...await orig<typeof import('../../lib/api')>(), api: { post: (...args: unknown[]) => post(...args) } }));

const S = 'S'.repeat(26), P = 'P'.repeat(26);
const plan = (status: PlanConnection['status'], extra: Partial<PlanConnection> = {}): PlanConnection =>
  ({ profileId: P, status, accountLabel: null, error: null, planOwnerId: null, ...extra });

beforeEach(() => { post.mockReset(); });
afterEach(() => { vi.useRealTimers(); });

describe('Continue with ChatGPT', () => {
  it('asks the host to start the sign-in and refreshes', async () => {
    post.mockResolvedValue(plan('requested'));
    const onChange = vi.fn();
    render(<ChatGPTPlanConnect serverId={S} profileId={P} hostName="desktop" plan={undefined} siwcMode onChange={onChange} />);
    expect(screen.getByRole('status').textContent).toContain('Not connected');
    fireEvent.click(screen.getByText('Continue with ChatGPT'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/servers/${S}/agent-profiles/${P}/plan`, { action: 'connect' }));
    expect(onChange).toHaveBeenCalled();
  });

  it('shows where the sign-in happens while the host works on it, and polls', () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(<ChatGPTPlanConnect serverId={S} profileId={P} hostName="desktop" plan={plan('in_progress')} siwcMode onChange={onChange} />);
    expect(screen.getByRole('status').textContent).toBe('Finish signing in in the browser on desktop.');
    expect((screen.getByText('Continue with ChatGPT') as HTMLButtonElement).disabled).toBe(true);
    act(() => { vi.advanceTimersByTime(3100); });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('shows the connected account, Manage usage and Disconnect', async () => {
    post.mockResolvedValue(plan('disconnect_requested'));
    render(<ChatGPTPlanConnect serverId={S} profileId={P} hostName="desktop" plan={plan('connected', { accountLabel: 'eryk@example.com' })} siwcMode onChange={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Using ChatGPT plan (eryk@example.com)');
    expect(screen.getByText('Manage usage').getAttribute('href')).toBe(USAGE_URL);
    expect(screen.queryByText('Continue with ChatGPT')).toBeNull();
    fireEvent.click(screen.getByText('Disconnect'));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/servers/${S}/agent-profiles/${P}/plan`, { action: 'disconnect' }));
  });

  it('explains a missing plan permission and a failed sign-in', () => {
    const { rerender } = render(<ChatGPTPlanConnect serverId={S} profileId={P} hostName="desktop" plan={plan('scope_missing')} siwcMode onChange={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain("using your ChatGPT plan wasn't allowed");
    expect(screen.getByText('Continue with ChatGPT')).toBeTruthy();
    rerender(<ChatGPTPlanConnect serverId={S} profileId={P} hostName="desktop" plan={plan('failed', { error: 'consent_declined' })} siwcMode onChange={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toBe('Sign-in was declined in the browser.');
  });

  it('says what to change in the host config when the profile is not siwc', () => {
    render(<ChatGPTPlanConnect serverId={S} profileId={P} hostName="desktop" plan={undefined} siwcMode={false} onChange={vi.fn()} />);
    expect(screen.getByText(/in the host's config and restart the host first/)).toBeTruthy();
  });

  it('shows who may connect when the server refuses', async () => {
    post.mockRejectedValue(new ApiError(403, 'forbidden'));
    render(<ChatGPTPlanConnect serverId={S} profileId={P} hostName="desktop" plan={undefined} siwcMode onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('Continue with ChatGPT'));
    expect((await screen.findByRole('alert')).textContent).toContain('Only the server owner or the person who registered this host');
  });
});
