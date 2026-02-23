import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import {
  resetMockState,
  setMockRoom,
  createMockRoom,
  MockRoomStatic,
} from '../../test/livekit-mocks.js';

vi.mock('@livekit/components-react', () => import('../../test/livekit-mocks.js'));
vi.mock('livekit-client', () => {
  const mocks = import('../../test/livekit-mocks.js');
  return mocks.then(m => ({
    ...m,
    Room: m.MockRoomStatic,
  }));
});

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

import { DeviceSelector } from './DeviceSelector';

function createMockDevice(deviceId: string, label: string, kind: string): MediaDeviceInfo {
  return {
    deviceId,
    label,
    kind: kind as MediaDeviceKind,
    groupId: 'group-1',
    toJSON: () => ({}),
  };
}

describe('DeviceSelector', () => {
  beforeEach(() => {
    resetMockState();
    vi.clearAllMocks();
    MockRoomStatic.getLocalDevices.mockReset();
    MockRoomStatic.getLocalDevices.mockResolvedValue([]);
  });

  it('renders nothing when closed', () => {
    const { container } = render(<DeviceSelector isOpen={false} onClose={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists audio input devices when open', async () => {
    MockRoomStatic.getLocalDevices.mockImplementation((kind: string) => {
      if (kind === 'audioinput') {
        return Promise.resolve([
          createMockDevice('mic-1', 'Built-in Mic', 'audioinput'),
          createMockDevice('mic-2', 'USB Mic', 'audioinput'),
        ]);
      }
      return Promise.resolve([]);
    });

    render(<DeviceSelector isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Built-in Mic')).toBeInTheDocument();
      expect(screen.getByText('USB Mic')).toBeInTheDocument();
    });
  });

  it('lists audio output devices', async () => {
    MockRoomStatic.getLocalDevices.mockImplementation((kind: string) => {
      if (kind === 'audiooutput') {
        return Promise.resolve([
          createMockDevice('spk-1', 'Built-in Speaker', 'audiooutput'),
        ]);
      }
      return Promise.resolve([]);
    });

    render(<DeviceSelector isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Speaker')).toBeInTheDocument();
      expect(screen.getByText('Built-in Speaker')).toBeInTheDocument();
    });
  });

  it('lists video input devices', async () => {
    MockRoomStatic.getLocalDevices.mockImplementation((kind: string) => {
      if (kind === 'videoinput') {
        return Promise.resolve([
          createMockDevice('cam-1', 'FaceTime Camera', 'videoinput'),
        ]);
      }
      return Promise.resolve([]);
    });

    render(<DeviceSelector isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Camera')).toBeInTheDocument();
      expect(screen.getByText('FaceTime Camera')).toBeInTheDocument();
    });
  });

  it('clicking a device calls room.switchActiveDevice', async () => {
    const room = createMockRoom();
    setMockRoom(room);

    MockRoomStatic.getLocalDevices.mockImplementation((kind: string) => {
      if (kind === 'audioinput') {
        return Promise.resolve([
          createMockDevice('mic-1', 'Built-in Mic', 'audioinput'),
          createMockDevice('mic-2', 'USB Mic', 'audioinput'),
        ]);
      }
      return Promise.resolve([]);
    });

    render(<DeviceSelector isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('USB Mic')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('USB Mic'));
    expect(room.switchActiveDevice).toHaveBeenCalledWith('audioinput', 'mic-2');
  });

  it('highlights the active device', async () => {
    const room = createMockRoom();
    room.getActiveDevice.mockReturnValue('mic-2');
    setMockRoom(room);

    MockRoomStatic.getLocalDevices.mockImplementation((kind: string) => {
      if (kind === 'audioinput') {
        return Promise.resolve([
          createMockDevice('mic-1', 'Built-in Mic', 'audioinput'),
          createMockDevice('mic-2', 'USB Mic', 'audioinput'),
        ]);
      }
      return Promise.resolve([]);
    });

    render(<DeviceSelector isOpen={true} onClose={vi.fn()} />);

    await waitFor(() => {
      const usbButton = screen.getByText('USB Mic');
      // Active device gets accent color styling
      expect(usbButton.style.color).not.toBe('');
      // Verify the two buttons have different styling
      const builtinButton = screen.getByText('Built-in Mic');
      expect(usbButton.style.color).not.toBe(builtinButton.style.color);
    });
  });

  it('closes on outside click', async () => {
    const onClose = vi.fn();
    MockRoomStatic.getLocalDevices.mockResolvedValue([]);

    render(<DeviceSelector isOpen={true} onClose={onClose} />);
    fireEvent.mouseDown(document.body);

    expect(onClose).toHaveBeenCalled();
  });
});
