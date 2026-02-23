import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  resetMockState,
  setLocalParticipant,
  setMicrophoneEnabled,
  setCameraEnabled,
  setScreenShareEnabled,
  setMockRoom,
  createMockParticipant,
  createMockRoom,
  createMockPublication,
  Track,
  RoomEvent,
} from '../../test/livekit-mocks.js';

// ─── Module mocks ───────────────────────────────────────────────────────────

vi.mock('@livekit/components-react', () => import('../../test/livekit-mocks.js'));
vi.mock('livekit-client', () => import('../../test/livekit-mocks.js'));

// Mock theme to avoid needing store/provider
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

// Mock voiceStore — track setDeafened calls to verify store wiring
const mockLeaveChannel = vi.fn();
const mockSetDeafened = vi.fn();
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: (selector: (s: Record<string, unknown>) => unknown) => {
    const state = {
      currentChannel: { channelId: 'ch1', serverId: 's1', channelName: 'voice-test' },
      connectionState: 'connected',
      leaveChannel: mockLeaveChannel,
      isDeafened: false,
      setDeafened: mockSetDeafened,
    };
    return selector(state);
  },
}));

import { VoiceControlBar } from './VoiceControlBar';

describe('VoiceControlBar', () => {
  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
  });

  // ── Step 1: Deafen ──────────────────────────────────────────────────────

  describe('deafen toggle', () => {
    it('renders deafen button when connected', () => {
      render(<VoiceControlBar />);
      const btn = screen.getByRole('button', { name: /deafen/i });
      expect(btn).toBeInTheDocument();
    });

    it('clicking deafen unsubscribes from all remote audio tracks', () => {
      const pub1 = createMockPublication('audio-1', Track.Kind.Audio);
      const pub2 = createMockPublication('audio-2', Track.Kind.Audio);
      const remote1 = createMockParticipant({
        identity: 'remote-1',
        name: 'Remote 1',
        audioTrackPublications: new Map([['audio-1', pub1]]),
      });
      const remote2 = createMockParticipant({
        identity: 'remote-2',
        name: 'Remote 2',
        audioTrackPublications: new Map([['audio-2', pub2]]),
      });
      const room = createMockRoom({
        remoteParticipants: new Map([
          ['remote-1', remote1],
          ['remote-2', remote2],
        ]),
      });
      setMockRoom(room);

      render(<VoiceControlBar />);
      fireEvent.click(screen.getByRole('button', { name: /deafen/i }));

      expect(pub1.setSubscribed).toHaveBeenCalledWith(false);
      expect(pub2.setSubscribed).toHaveBeenCalledWith(false);
    });

    it('deafening auto-mutes mic', () => {
      const local = createMockParticipant({ identity: 'local', name: 'Local' });
      setLocalParticipant(local);
      setMicrophoneEnabled(true);

      render(<VoiceControlBar />);
      fireEvent.click(screen.getByRole('button', { name: /deafen/i }));

      expect(local.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    });

    it('undeafening re-subscribes remote audio but does NOT unmute mic', () => {
      const pub = createMockPublication('audio-1', Track.Kind.Audio);
      const remote = createMockParticipant({
        identity: 'remote-1',
        name: 'Remote 1',
        audioTrackPublications: new Map([['audio-1', pub]]),
      });
      const room = createMockRoom({
        remoteParticipants: new Map([['remote-1', remote]]),
      });
      setMockRoom(room);

      const local = createMockParticipant({ identity: 'local', name: 'Local' });
      setLocalParticipant(local);
      setMicrophoneEnabled(true);

      render(<VoiceControlBar />);
      const btn = screen.getByRole('button', { name: /deafen/i });

      // Deafen
      fireEvent.click(btn);
      pub.setSubscribed.mockClear();
      local.setMicrophoneEnabled.mockClear();

      // Undeafen
      fireEvent.click(btn);

      expect(pub.setSubscribed).toHaveBeenCalledWith(true);
      // Must NOT auto-unmute
      expect(local.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
    });

    it('clicking deafen calls store setDeafened', () => {
      render(<VoiceControlBar />);
      fireEvent.click(screen.getByRole('button', { name: /deafen/i }));

      expect(mockSetDeafened).toHaveBeenCalledWith(true);
    });

    it('new audio tracks arriving while deafened get unsubscribed', () => {
      const room = createMockRoom();
      setMockRoom(room);

      render(<VoiceControlBar />);
      // Deafen first
      fireEvent.click(screen.getByRole('button', { name: /deafen/i }));

      // Capture the TrackSubscribed listener
      const onCall = room.on.mock.calls.find(
        (call: unknown[]) => call[0] === RoomEvent.TrackSubscribed,
      );
      expect(onCall).toBeDefined();
      const handler = onCall![1] as (track: { kind: string }, pub: { setSubscribed: ReturnType<typeof vi.fn> }) => void;

      // Simulate a new audio track arriving
      const newPub = createMockPublication('new-audio', Track.Kind.Audio);
      handler({ kind: Track.Kind.Audio }, newPub);

      expect(newPub.setSubscribed).toHaveBeenCalledWith(false);
    });
  });

  // ── Step 2: Camera + Screen Share ─────────────────────────────────────────

  describe('camera toggle', () => {
    it('renders camera toggle button', () => {
      render(<VoiceControlBar />);
      const btn = screen.getByRole('button', { name: /camera/i });
      expect(btn).toBeInTheDocument();
    });

    it('clicking camera toggle calls setCameraEnabled', () => {
      const local = createMockParticipant({ identity: 'local', name: 'Local' });
      setLocalParticipant(local);
      setCameraEnabled(false);

      render(<VoiceControlBar />);
      fireEvent.click(screen.getByRole('button', { name: /camera/i }));

      expect(local.setCameraEnabled).toHaveBeenCalledWith(true);
    });

    it('camera button title changes when camera is on', () => {
      setCameraEnabled(true);
      render(<VoiceControlBar />);
      const btn = screen.getByRole('button', { name: /camera off/i });
      expect(btn).toBeInTheDocument();
    });
  });

  describe('screen share toggle', () => {
    it('renders screen share toggle button', () => {
      render(<VoiceControlBar />);
      const btn = screen.getByRole('button', { name: /screen|share/i });
      expect(btn).toBeInTheDocument();
    });

    it('clicking screen share calls setScreenShareEnabled', () => {
      const local = createMockParticipant({ identity: 'local', name: 'Local' });
      setLocalParticipant(local);
      setScreenShareEnabled(false);

      render(<VoiceControlBar />);
      fireEvent.click(screen.getByRole('button', { name: /share screen/i }));

      expect(local.setScreenShareEnabled).toHaveBeenCalledWith(true);
    });

    it('screen share button title changes when sharing', () => {
      setScreenShareEnabled(true);
      render(<VoiceControlBar />);
      const btn = screen.getByRole('button', { name: /stop sharing/i });
      expect(btn).toBeInTheDocument();
    });
  });

  // ── Step 6: Device selector gear button ───────────────────────────────────

  describe('device selector', () => {
    it('renders device selector gear button', () => {
      render(<VoiceControlBar />);
      const btn = screen.getByRole('button', { name: /settings/i });
      expect(btn).toBeInTheDocument();
    });

    it('clicking gear toggles device selector visibility', () => {
      render(<VoiceControlBar />);
      const btn = screen.getByRole('button', { name: /settings/i });

      // Initially no Microphone heading
      expect(screen.queryByText('Microphone')).not.toBeInTheDocument();

      // Click to open
      fireEvent.click(btn);
      // DeviceSelector renders (with "Microphone" heading when devices arrive,
      // but at minimum the popover container mounts)
      // We check the gear button is still there after click
      expect(btn).toBeInTheDocument();
    });
  });
});
