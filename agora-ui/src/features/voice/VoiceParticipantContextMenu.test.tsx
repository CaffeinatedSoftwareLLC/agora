import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

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

const mockMute = vi.fn();
const mockUnmute = vi.fn();
const mockDeafen = vi.fn();
const mockUndeafen = vi.fn();
const mockKick = vi.fn();

vi.mock('../../lib/api', () => ({
  voiceApi: {
    mute: (...args: unknown[]) => mockMute(...args),
    unmute: (...args: unknown[]) => mockUnmute(...args),
    deafen: (...args: unknown[]) => mockDeafen(...args),
    undeafen: (...args: unknown[]) => mockUndeafen(...args),
    kick: (...args: unknown[]) => mockKick(...args),
  },
}));

import { VoiceParticipantContextMenu } from './VoiceParticipantContextMenu';

const baseProps = {
  x: 100,
  y: 200,
  channelId: 'ch1',
  targetUserId: 'user-2',
  targetName: 'Alice',
  permissions: { canMuteMembers: true, canDeafenMembers: true, canMoveMembers: true },
  isSelf: false,
  targetCanPublish: true,
  targetCanSubscribe: true,
  onClose: vi.fn(),
  onActionComplete: vi.fn(),
};

describe('VoiceParticipantContextMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMute.mockResolvedValue({});
    mockUnmute.mockResolvedValue({});
    mockDeafen.mockResolvedValue({});
    mockUndeafen.mockResolvedValue({});
    mockKick.mockResolvedValue({});
  });

  it('renders nothing when isSelf is true', () => {
    const { container } = render(
      <VoiceParticipantContextMenu {...baseProps} isSelf={true} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing when no permissions', () => {
    const { container } = render(
      <VoiceParticipantContextMenu
        {...baseProps}
        permissions={{ canMuteMembers: false, canDeafenMembers: false, canMoveMembers: false }}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('shows Mute when canMuteMembers and targetCanPublish is true', () => {
    render(<VoiceParticipantContextMenu {...baseProps} targetCanPublish={true} />);
    expect(screen.getByRole('button', { name: 'Mute' })).toBeInTheDocument();
  });

  it('shows Unmute when canMuteMembers and targetCanPublish is false', () => {
    render(<VoiceParticipantContextMenu {...baseProps} targetCanPublish={false} />);
    expect(screen.getByRole('button', { name: 'Unmute' })).toBeInTheDocument();
  });

  it('shows Deafen when canDeafenMembers and targetCanSubscribe is true', () => {
    render(<VoiceParticipantContextMenu {...baseProps} targetCanSubscribe={true} />);
    expect(screen.getByRole('button', { name: 'Deafen' })).toBeInTheDocument();
  });

  it('shows Undeafen when canDeafenMembers and targetCanSubscribe is false', () => {
    render(<VoiceParticipantContextMenu {...baseProps} targetCanSubscribe={false} />);
    expect(screen.getByRole('button', { name: 'Undeafen' })).toBeInTheDocument();
  });

  it('shows Disconnect when canMoveMembers', () => {
    render(<VoiceParticipantContextMenu {...baseProps} />);
    expect(screen.getByRole('button', { name: /Disconnect/ })).toBeInTheDocument();
  });

  it('calls voiceApi.mute on Mute click, then onActionComplete, then onClose', async () => {
    render(<VoiceParticipantContextMenu {...baseProps} targetCanPublish={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));

    await waitFor(() => {
      expect(mockMute).toHaveBeenCalledWith('ch1', 'user-2');
      expect(baseProps.onActionComplete).toHaveBeenCalled();
      expect(baseProps.onClose).toHaveBeenCalled();
    });
  });

  it('calls voiceApi.unmute on Unmute click, then onActionComplete, then onClose', async () => {
    render(<VoiceParticipantContextMenu {...baseProps} targetCanPublish={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));

    await waitFor(() => {
      expect(mockUnmute).toHaveBeenCalledWith('ch1', 'user-2');
      expect(baseProps.onActionComplete).toHaveBeenCalled();
      expect(baseProps.onClose).toHaveBeenCalled();
    });
  });

  it('calls voiceApi.deafen on Deafen click, then onActionComplete, then onClose', async () => {
    render(<VoiceParticipantContextMenu {...baseProps} targetCanSubscribe={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Deafen' }));

    await waitFor(() => {
      expect(mockDeafen).toHaveBeenCalledWith('ch1', 'user-2');
      expect(baseProps.onActionComplete).toHaveBeenCalled();
      expect(baseProps.onClose).toHaveBeenCalled();
    });
  });

  it('calls voiceApi.undeafen on Undeafen click, then onActionComplete, then onClose', async () => {
    render(<VoiceParticipantContextMenu {...baseProps} targetCanSubscribe={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Undeafen' }));

    await waitFor(() => {
      expect(mockUndeafen).toHaveBeenCalledWith('ch1', 'user-2');
      expect(baseProps.onActionComplete).toHaveBeenCalled();
      expect(baseProps.onClose).toHaveBeenCalled();
    });
  });

  it('calls voiceApi.kick on Disconnect click, then onActionComplete, then onClose', async () => {
    render(<VoiceParticipantContextMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));

    await waitFor(() => {
      expect(mockKick).toHaveBeenCalledWith('ch1', 'user-2');
      expect(baseProps.onActionComplete).toHaveBeenCalled();
      expect(baseProps.onClose).toHaveBeenCalled();
    });
  });

  it('on API error: keeps menu open, shows inline error, does NOT call onActionComplete or onClose', async () => {
    mockMute.mockRejectedValue(new Error('server error'));

    render(<VoiceParticipantContextMenu {...baseProps} targetCanPublish={true} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));

    await waitFor(() => {
      expect(screen.getByText('Action failed')).toBeInTheDocument();
    });
    expect(baseProps.onActionComplete).not.toHaveBeenCalled();
    expect(baseProps.onClose).not.toHaveBeenCalled();
  });

  it('closes on Escape key', () => {
    render(<VoiceParticipantContextMenu {...baseProps} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(baseProps.onClose).toHaveBeenCalled();
    expect(baseProps.onActionComplete).not.toHaveBeenCalled();
  });
});
