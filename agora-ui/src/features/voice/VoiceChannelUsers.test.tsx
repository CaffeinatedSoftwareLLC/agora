import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  resetMockState,
  setMockParticipants,
  createMockParticipant,
} from '../../test/livekit-mocks.js';

vi.mock('@livekit/components-react', () => import('../../test/livekit-mocks.js'));
vi.mock('livekit-client', () => import('../../test/livekit-mocks.js'));

vi.mock('../../theme', () => {
  const AEGEAN = {
    bg: '#241623', surface: '#332838', surfaceHover: '#3E3345',
    primary: '#0D5EAF', primaryHover: '#0B4E95', accent: '#0FA3B1',
    text: '#FDFFF7', white: '#FCFCFC', muted: '#A09AAB', dim: '#6E6479',
    border: '#3A2E3E', online: '#4ADE80', danger: '#EF4444', warn: '#FBBF24',
  };
  return {
    usePalette: () => AEGEAN,
    hexToRgb: (hex: string) => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `${r}, ${g}, ${b}`;
    },
  };
});

const mockGetParticipants = vi.fn();
const mockGetPermissions = vi.fn();

vi.mock('../../lib/api', () => ({
  voiceApi: {
    getParticipants: (...args: unknown[]) => mockGetParticipants(...args),
    getPermissions: (...args: unknown[]) => mockGetPermissions(...args),
    mute: vi.fn().mockResolvedValue({}),
    unmute: vi.fn().mockResolvedValue({}),
    deafen: vi.fn().mockResolvedValue({}),
    undeafen: vi.fn().mockResolvedValue({}),
    kick: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      currentChannel: { channelId: 'ch1', serverId: 's1', channelName: 'voice-test' },
      connectionState: 'connected',
      participantsByChannel: new Map(),
    };
    return selector(state);
  },
}));

vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      user: { id: 'current-user', username: 'Me' },
      token: 'fake-token',
    };
    return selector(state);
  },
}));

import { VoiceChannelUsers } from './VoiceChannelUsers';

describe('VoiceChannelUsers', () => {
  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
    mockGetPermissions.mockResolvedValue({
      canMuteMembers: true,
      canDeafenMembers: true,
      canMoveMembers: true,
    });
    mockGetParticipants.mockResolvedValue([
      { identity: 'other-user', name: 'Alice', permission: { canPublish: true, canSubscribe: true } },
      { identity: 'current-user', name: 'Me', permission: { canPublish: true, canSubscribe: true } },
    ]);
  });

  it('right-click on non-self participant opens context menu', async () => {
    const other = createMockParticipant({ identity: 'other-user', name: 'Alice' });
    const self = createMockParticipant({ identity: 'current-user', name: 'Me' });
    setMockParticipants([other, self]);

    render(<VoiceChannelUsers channelId="ch1" />);

    const aliceEl = screen.getByText('Alice');
    fireEvent.contextMenu(aliceEl);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Deafen' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Disconnect/ })).toBeInTheDocument();
  });

  it('right-click on self does not open context menu', async () => {
    const other = createMockParticipant({ identity: 'other-user', name: 'Alice' });
    const self = createMockParticipant({ identity: 'current-user', name: 'Me' });
    setMockParticipants([other, self]);

    render(<VoiceChannelUsers channelId="ch1" />);

    const meEl = screen.getByText('Me');
    fireEvent.contextMenu(meEl);

    // Wait for fetch to resolve
    await waitFor(() => {
      expect(mockGetParticipants).toHaveBeenCalled();
    });

    expect(screen.queryByRole('button', { name: 'Mute' })).not.toBeInTheDocument();
  });

  it('right-click when no admin permissions shows no menu', async () => {
    mockGetPermissions.mockResolvedValue({
      canMuteMembers: false,
      canDeafenMembers: false,
      canMoveMembers: false,
    });

    const other = createMockParticipant({ identity: 'other-user', name: 'Alice' });
    setMockParticipants([other]);

    render(<VoiceChannelUsers channelId="ch1" />);

    const aliceEl = screen.getByText('Alice');
    fireEvent.contextMenu(aliceEl);

    await waitFor(() => {
      expect(mockGetParticipants).toHaveBeenCalled();
    });

    expect(screen.queryByRole('button', { name: 'Mute' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
  });
});
