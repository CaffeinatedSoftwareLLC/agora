import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  resetMockState,
  setMockTracks,
  setMockScreenShareTracks,
  createMockTrackRef,
  Track,
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

import { VideoGrid } from './VideoGrid';

describe('VideoGrid', () => {
  beforeEach(() => {
    resetMockState();
  });

  it('returns null when no tracks', () => {
    setMockTracks([]);
    setMockScreenShareTracks([]);
    const { container } = render(<VideoGrid />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a VideoTrack for each camera track', () => {
    setMockTracks([
      createMockTrackRef(Track.Source.Camera, { identity: 'alice', name: 'Alice' }),
      createMockTrackRef(Track.Source.Camera, { identity: 'bob', name: 'Bob' }),
    ]);
    setMockScreenShareTracks([]);

    render(<VideoGrid />);
    const tracks = screen.getAllByTestId('video-track');
    expect(tracks).toHaveLength(2);
  });

  it('renders focused layout when screen share present', () => {
    setMockTracks([
      createMockTrackRef(Track.Source.Camera, { identity: 'alice', name: 'Alice' }),
      createMockTrackRef(Track.Source.Camera, { identity: 'bob', name: 'Bob' }),
    ]);
    setMockScreenShareTracks([
      createMockTrackRef(Track.Source.ScreenShare, { identity: 'alice', name: 'Alice' }),
    ]);

    render(<VideoGrid />);
    const tracks = screen.getAllByTestId('video-track');
    expect(tracks).toHaveLength(3);
    expect(screen.getByText(/\(Screen\)/)).toBeInTheDocument();
  });

  it('camera-only grid renders correct number of tiles', () => {
    setMockTracks([
      createMockTrackRef(Track.Source.Camera, { identity: 'a', name: 'A' }),
      createMockTrackRef(Track.Source.Camera, { identity: 'b', name: 'B' }),
      createMockTrackRef(Track.Source.Camera, { identity: 'c', name: 'C' }),
    ]);
    setMockScreenShareTracks([]);

    render(<VideoGrid />);
    expect(screen.getAllByTestId('video-track')).toHaveLength(3);
    expect(screen.queryByText(/\(Screen\)/)).not.toBeInTheDocument();
  });

  it('shows participant name overlay on tiles', () => {
    setMockTracks([
      createMockTrackRef(Track.Source.Camera, { identity: 'alice', name: 'Alice' }),
      createMockTrackRef(Track.Source.Camera, { identity: 'bob', name: 'Bob' }),
    ]);
    setMockScreenShareTracks([]);

    render(<VideoGrid />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });
});
