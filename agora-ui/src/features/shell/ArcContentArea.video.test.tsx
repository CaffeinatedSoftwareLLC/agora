import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  resetMockState,
  setMockTracks,
  setMockScreenShareTracks,
  createMockTrackRef,
  Track,
} from '../../test/livekit-mocks.js';

// ─── Module mocks ───────────────────────────────────────────────────────────

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

// Mock child components to simplify rendering
vi.mock('../messages/MessageList', () => ({
  MessageList: () => <div data-testid="message-list">MessageList</div>,
}));
vi.mock('../messages/FloatingMessageInput', () => ({
  FloatingMessageInput: () => <div data-testid="message-input">Input</div>,
}));
vi.mock('../live/TypingIndicator', () => ({
  TypingIndicator: () => <div data-testid="typing-indicator" />,
}));

// Voice connection state control
let mockVoiceConnectionState = 'disconnected';

vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: (selector: (s: Record<string, unknown>) => unknown) => {
    return selector({ connectionState: mockVoiceConnectionState });
  },
}));

// Channel store control
let mockActiveChannelId: string | null = 'ch1';
const mockChannels = new Map([
  ['ch1', { id: 'ch1', name: 'general', serverId: 's1', type: 3 }],
]);

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (s: Record<string, unknown>) => unknown) => {
    return selector({ activeChannelId: mockActiveChannelId, channels: mockChannels });
  },
}));

vi.mock('../../stores/serverStore', () => ({
  useServerStore: (selector: (s: Record<string, unknown>) => unknown) => {
    return selector({
      instanceServerId: 's1',
      servers: new Map([['s1', { id: 's1', name: 'Test Server' }]]),
    });
  },
}));

vi.mock('../../stores/uiStore', () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) => {
    return selector({ membersOpen: false, toggleMembers: vi.fn(), paletteKey: 'aegean' });
  },
}));

import { ArcContentArea } from './ArcContentArea';

describe('ArcContentArea video integration', () => {
  beforeEach(() => {
    resetMockState();
    mockVoiceConnectionState = 'disconnected';
    mockActiveChannelId = 'ch1';
  });

  it('renders without error when voice is disconnected', () => {
    mockVoiceConnectionState = 'disconnected';
    const { container } = render(<ArcContentArea />);
    expect(container.querySelector('[data-testid="video-track"]')).toBeNull();
  });

  it('does not render video panel when connected but no video tracks', () => {
    mockVoiceConnectionState = 'connected';
    setMockTracks([]);
    setMockScreenShareTracks([]);

    render(<ArcContentArea />);
    expect(screen.queryByTestId('video-track')).not.toBeInTheDocument();
  });

  it('renders video panel above messages when connected with tracks', () => {
    mockVoiceConnectionState = 'connected';
    setMockTracks([
      createMockTrackRef(Track.Source.Camera, { identity: 'alice', name: 'Alice' }),
    ]);
    setMockScreenShareTracks([]);

    render(<ArcContentArea />);
    expect(screen.getByTestId('video-track')).toBeInTheDocument();
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('video panel removed when tracks disappear', () => {
    mockVoiceConnectionState = 'connected';
    setMockTracks([
      createMockTrackRef(Track.Source.Camera, { identity: 'alice', name: 'Alice' }),
    ]);
    setMockScreenShareTracks([]);

    const { rerender } = render(<ArcContentArea />);
    expect(screen.getByTestId('video-track')).toBeInTheDocument();

    // Remove tracks
    setMockTracks([]);
    rerender(<ArcContentArea />);
    expect(screen.queryByTestId('video-track')).not.toBeInTheDocument();
  });
});
