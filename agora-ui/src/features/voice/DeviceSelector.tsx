import { useState, useEffect, useRef, useCallback } from 'react';
import { useRoomContext } from '@livekit/components-react';
import { Room } from 'livekit-client';
import { usePalette } from '../../theme';

interface DeviceSelectorProps {
  isOpen: boolean;
  onClose: () => void;
}

interface DevicesByKind {
  audioinput: MediaDeviceInfo[];
  audiooutput: MediaDeviceInfo[];
  videoinput: MediaDeviceInfo[];
}

type DeviceKind = 'audioinput' | 'audiooutput' | 'videoinput';

export function DeviceSelector({ isOpen, onClose }: DeviceSelectorProps) {
  const P = usePalette();
  const room = useRoomContext();
  const ref = useRef<HTMLDivElement>(null);
  const [devices, setDevices] = useState<DevicesByKind>({
    audioinput: [],
    audiooutput: [],
    videoinput: [],
  });
  const [activeDevices, setActiveDevices] = useState<Record<DeviceKind, string>>({
    audioinput: '',
    audiooutput: '',
    videoinput: '',
  });

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;

    async function load() {
      try {
        const [ai, ao, vi] = await Promise.all([
          Room.getLocalDevices('audioinput'),
          Room.getLocalDevices('audiooutput'),
          Room.getLocalDevices('videoinput'),
        ]);
        if (!cancelled) {
          setDevices({ audioinput: ai, audiooutput: ao, videoinput: vi });
          setActiveDevices({
            audioinput: room.getActiveDevice('audioinput') ?? '',
            audiooutput: room.getActiveDevice('audiooutput') ?? '',
            videoinput: room.getActiveDevice('videoinput') ?? '',
          });
        }
      } catch {
        // Device enumeration can fail (permissions denied, no devices).
        // Leave devices empty — the selector will show nothing.
      }
    }
    load();

    return () => { cancelled = true; };
  }, [isOpen, room]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, onClose]);

  const switchDevice = useCallback(async (kind: DeviceKind, deviceId: string) => {
    const prev = activeDevices[kind];
    setActiveDevices(s => ({ ...s, [kind]: deviceId }));
    try {
      await room.switchActiveDevice(kind, deviceId);
    } catch {
      setActiveDevices(s => ({ ...s, [kind]: prev }));
    }
  }, [room, activeDevices]);

  if (!isOpen) return null;

  const sections: { label: string; kind: DeviceKind; items: MediaDeviceInfo[] }[] = [
    { label: 'Microphone', kind: 'audioinput', items: devices.audioinput },
    { label: 'Speaker', kind: 'audiooutput', items: devices.audiooutput },
    { label: 'Camera', kind: 'videoinput', items: devices.videoinput },
  ];

  return (
    <div
      ref={ref}
      className="absolute bottom-full left-0 mb-2 w-64 rounded-xl p-3 z-50"
      style={{
        background: P.surface,
        border: `1px solid ${P.border}`,
      }}
    >
      {sections.map(({ label, kind, items }) =>
        items.length > 0 ? (
          <div key={kind} className="mb-3 last:mb-0">
            <div
              className="text-[10px] font-semibold uppercase tracking-wide mb-1.5"
              style={{ color: P.dim }}
            >
              {label}
            </div>
            {items.map(device => {
              const isActive = activeDevices[kind] === device.deviceId;
              return (
                <button
                  key={device.deviceId}
                  onClick={() => switchDevice(kind, device.deviceId)}
                  className="w-full text-left px-2 py-1.5 rounded-lg text-[12px] transition-colors"
                  style={{
                    color: isActive ? P.accent : P.text,
                    background: isActive ? `${P.accent}15` : 'transparent',
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = isActive ? `${P.accent}25` : P.surfaceHover; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = isActive ? `${P.accent}15` : 'transparent'; }}
                >
                  {device.label}
                </button>
              );
            })}
          </div>
        ) : null,
      )}
    </div>
  );
}
