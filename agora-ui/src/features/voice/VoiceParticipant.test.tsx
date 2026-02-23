import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  resetMockState,
  setIsSpeaking,
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

import { VoiceParticipant } from './VoiceParticipant';

describe('VoiceParticipant', () => {
  beforeEach(() => {
    resetMockState();
    setIsSpeaking(false);
  });

  it('shows camera icon when participant has camera enabled', () => {
    const p = createMockParticipant({ identity: 'alice', name: 'Alice', isCameraEnabled: true });
    render(<VoiceParticipant participant={p as unknown as import('livekit-client').Participant} />);
    expect(screen.getByTitle('Camera On')).toBeInTheDocument();
  });

  it('hides camera icon when camera disabled', () => {
    const p = createMockParticipant({ identity: 'alice', name: 'Alice', isCameraEnabled: false });
    render(<VoiceParticipant participant={p as unknown as import('livekit-client').Participant} />);
    expect(screen.queryByTitle('Camera On')).not.toBeInTheDocument();
  });

  it('shows screen share icon when sharing', () => {
    const p = createMockParticipant({ identity: 'alice', name: 'Alice', isScreenShareEnabled: true });
    render(<VoiceParticipant participant={p as unknown as import('livekit-client').Participant} />);
    expect(screen.getByTitle('Screen Sharing')).toBeInTheDocument();
  });

  it('preserves existing mute indicator', () => {
    const p = createMockParticipant({ identity: 'alice', name: 'Alice', isMicrophoneEnabled: false });
    render(<VoiceParticipant participant={p as unknown as import('livekit-client').Participant} />);
    // The mute icon SVG should still render
    const svgs = document.querySelectorAll('svg');
    expect(svgs.length).toBeGreaterThanOrEqual(1);
    // Also verify the name still displays
    expect(screen.getByText('Alice')).toBeInTheDocument();
  });
});
