/* eslint-disable react-refresh/only-export-components */
/**
 * Shared mock infrastructure for LiveKit-dependent component tests.
 * All voice/video Phase 2 tests import from here.
 */
import { vi } from 'vitest';

// ─── livekit-client enum re-exports (real string values) ────────────────────

export const Track = {
  Source: {
    Camera: 'camera' as const,
    Microphone: 'microphone' as const,
    ScreenShare: 'screen_share' as const,
    ScreenShareAudio: 'screen_share_audio' as const,
  },
  Kind: {
    Audio: 'audio' as const,
    Video: 'video' as const,
  },
};

export const RoomEvent = {
  TrackSubscribed: 'trackSubscribed' as const,
};

export const ConnectionState = {
  Connected: 'connected' as const,
  Disconnected: 'disconnected' as const,
};

// ─── Controllable hook state ────────────────────────────────────────────────

let _localParticipant = createMockParticipant({ identity: 'local-user', name: 'Local User' });
let _isMicrophoneEnabled = true;
let _isCameraEnabled = false;
let _isScreenShareEnabled = false;
let _room = createMockRoom();
let _tracks: MockTrackRef[] = [];
let _screenShareTracks: MockTrackRef[] = [];
let _isSpeaking = false;
let _participants: MockParticipant[] = [];
let _connectionState: string = ConnectionState.Connected;

// Setters — call these in tests to control hook return values
export function setLocalParticipant(p: MockParticipant) { _localParticipant = p; }
export function setMicrophoneEnabled(v: boolean) { _isMicrophoneEnabled = v; }
export function setCameraEnabled(v: boolean) { _isCameraEnabled = v; }
export function setScreenShareEnabled(v: boolean) { _isScreenShareEnabled = v; }
export function setMockRoom(r: MockRoom) { _room = r; }
export function setMockTracks(t: MockTrackRef[]) { _tracks = t; }
export function setMockScreenShareTracks(t: MockTrackRef[]) { _screenShareTracks = t; }
export function setIsSpeaking(v: boolean) { _isSpeaking = v; }
export function setMockParticipants(p: MockParticipant[]) { _participants = p; }
export function setConnectionState(s: string) { _connectionState = s; }

/** Reset all hook state to defaults */
export function resetMockState() {
  _localParticipant = createMockParticipant({ identity: 'local-user', name: 'Local User' });
  _isMicrophoneEnabled = true;
  _isCameraEnabled = false;
  _isScreenShareEnabled = false;
  _room = createMockRoom();
  _tracks = [];
  _screenShareTracks = [];
  _isSpeaking = false;
  _participants = [];
  _connectionState = ConnectionState.Connected;
}

// ─── Mock hook implementations ──────────────────────────────────────────────

export function useLocalParticipant() {
  return {
    localParticipant: _localParticipant,
    isMicrophoneEnabled: _isMicrophoneEnabled,
    isCameraEnabled: _isCameraEnabled,
    isScreenShareEnabled: _isScreenShareEnabled,
  };
}

export function useRoomContext() {
  return _room;
}

export function useTracks(sources: string[]) {
  // Route to the correct mock based on the requested sources
  if (sources.length === 1 && sources[0] === Track.Source.ScreenShare) {
    return _screenShareTracks;
  }
  if (sources.length === 1 && sources[0] === Track.Source.Camera) {
    return _tracks;
  }
  // Mixed sources — return all
  return [..._tracks, ..._screenShareTracks];
}

export function useIsSpeaking() {
  return _isSpeaking;
}

export function useParticipants() {
  return _participants;
}

export function useConnectionState() {
  return _connectionState;
}

// ─── Mock components ────────────────────────────────────────────────────────

export function LiveKitRoom({ children }: { children?: React.ReactNode }) {
  return children;
}

export function RoomAudioRenderer() {
  return null;
}

export function VideoTrack({ trackRef }: { trackRef: MockTrackRef; style?: React.CSSProperties }) {
  return (
    <div
      data-testid="video-track"
      data-participant={trackRef.participant.identity}
      data-source={trackRef.source}
    />
  );
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MockPublication {
  trackSid: string;
  setSubscribed: ReturnType<typeof vi.fn>;
  track?: { kind: string; setEnabled: ReturnType<typeof vi.fn> };
}

export interface MockParticipant {
  identity: string;
  name: string;
  sid: string;
  isMicrophoneEnabled: boolean;
  isCameraEnabled: boolean;
  isScreenShareEnabled: boolean;
  audioTrackPublications: Map<string, MockPublication>;
  setMicrophoneEnabled: ReturnType<typeof vi.fn>;
  setCameraEnabled: ReturnType<typeof vi.fn>;
  setScreenShareEnabled: ReturnType<typeof vi.fn>;
}

export interface MockTrackRef {
  source: string;
  participant: { identity: string; name: string };
  publication?: { trackSid: string };
}

export interface MockRoom {
  remoteParticipants: Map<string, MockParticipant>;
  disconnect: ReturnType<typeof vi.fn>;
  switchActiveDevice: ReturnType<typeof vi.fn>;
  getActiveDevice: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}

// ─── Factories ──────────────────────────────────────────────────────────────

export function createMockParticipant(overrides?: Partial<MockParticipant>): MockParticipant {
  return {
    identity: 'user-1',
    name: 'User 1',
    sid: 'sid-1',
    isMicrophoneEnabled: true,
    isCameraEnabled: false,
    isScreenShareEnabled: false,
    audioTrackPublications: new Map(),
    setMicrophoneEnabled: vi.fn(),
    setCameraEnabled: vi.fn(),
    setScreenShareEnabled: vi.fn(),
    ...overrides,
  };
}

export function createMockTrackRef(
  source: string,
  participant: { identity: string; name: string },
  trackSid?: string,
): MockTrackRef {
  return {
    source,
    participant,
    publication: { trackSid: trackSid ?? `track-${source}-${participant.identity}` },
  };
}

export function createMockRoom(options?: Partial<MockRoom>): MockRoom {
  return {
    remoteParticipants: new Map(),
    disconnect: vi.fn(),
    switchActiveDevice: vi.fn().mockResolvedValue(true),
    getActiveDevice: vi.fn().mockReturnValue('default'),
    on: vi.fn(),
    off: vi.fn(),
    ...options,
  };
}

export function createMockPublication(trackSid: string, kind?: string): MockPublication {
  return {
    trackSid,
    setSubscribed: vi.fn(),
    track: kind ? { kind, setEnabled: vi.fn() } : undefined,
  };
}

// ─── Static Room mock (for device enumeration) ─────────────────────────────

export const MockRoomStatic = {
  getLocalDevices: vi.fn().mockResolvedValue([]),
};

// Also export as `Room` so `import { Room } from 'livekit-client'` works
export const Room = MockRoomStatic;
