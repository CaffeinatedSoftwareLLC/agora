import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ChannelVoice } from '../../lib/api';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const transcribe = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => {
  const actual = await orig<typeof import('../../lib/api')>();
  return { ...actual, voiceApi: { ...actual.voiceApi, transcribe: (c: string, b: Blob) => transcribe(c, b) } };
});

import { MicButton } from './MicButton';
import { useVoiceStore } from './voiceStore';

const SERVER: ChannelVoice = { input: 'server', output: 'browser', maxRecordingSeconds: 60, language: 'en', maxChars: 1500 };

/** A MediaRecorder that hands back one chunk when stopped. */
class FakeRecorder {
  static last: FakeRecorder | null = null;
  static isTypeSupported = (t: string) => t === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(_stream: unknown, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType ?? ''; FakeRecorder.last = this; }
  start() { this.state = 'recording'; }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['opus'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

const stopTrack = vi.fn();
let now = 1_000_000;

beforeEach(() => {
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: stopTrack }] })) },
  });
  useVoiceStore.setState({ channels: { C1: SERVER } });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  transcribe.mockReset();
  stopTrack.mockReset();
  FakeRecorder.last = null;
});

const mic = () => screen.getByRole('button', { name: /voice input|stop recording|transcribing/i });

describe('MicButton', () => {
  it('hold to talk: records while held, then puts the transcript in the draft', async () => {
    transcribe.mockResolvedValue('run the failing test again');
    const onText = vi.fn();
    render(<MicButton channelId="C1" onText={onText} />);

    fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    await waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'));
    expect(screen.getByRole('status')).toHaveTextContent('Release to transcribe');
    now += 2000;
    fireEvent.pointerUp(mic(), { pointerId: 1 });

    await waitFor(() => expect(onText).toHaveBeenCalledWith('run the failing test again'));
    const [channelId, clip] = transcribe.mock.calls[0] as [string, Blob];
    expect(channelId).toBe('C1');
    expect(clip.type).toBe('audio/webm');
    expect(stopTrack).toHaveBeenCalled();
  });

  it('tap to start and tap again to stop', async () => {
    transcribe.mockResolvedValue('hello');
    const onText = vi.fn();
    render(<MicButton channelId="C1" onText={onText} />);

    fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    await waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'));
    now += 100;
    fireEvent.pointerUp(mic(), { pointerId: 1 });
    expect(FakeRecorder.last?.state).toBe('recording');
    expect(screen.getByRole('status')).toHaveTextContent('Tap the mic to stop');

    now += 3000;
    fireEvent.pointerDown(mic(), { button: 0, pointerId: 2 });
    fireEvent.pointerUp(mic(), { pointerId: 2 });
    await waitFor(() => expect(onText).toHaveBeenCalledWith('hello'));
  });

  it('Escape cancels a recording without transcribing it', async () => {
    render(<MicButton channelId="C1" onText={vi.fn()} />);
    fireEvent.keyDown(mic(), { key: 'Enter' });
    await waitFor(() => expect(FakeRecorder.last?.state).toBe('recording'));
    now += 5000;
    fireEvent.keyDown(mic(), { key: 'Escape' });
    await act(async () => {});
    expect(transcribe).not.toHaveBeenCalled();
    expect(FakeRecorder.last?.state).toBe('inactive');
  });

  it('says when the microphone is refused', async () => {
    (navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    render(<MicButton channelId="C1" onText={vi.fn()} />);
    fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    expect(await screen.findByRole('alert')).toHaveTextContent('Microphone access was refused');
  });

  it('uses the browser’s speech recognition when that is the engine', async () => {
    let instance: { onresult: (e: unknown) => void; onend: () => void; lang: string } | null = null;
    class FakeRecognition {
      lang = ''; continuous = false; interimResults = false;
      onresult: ((e: unknown) => void) | null = null; onerror = null; onend: (() => void) | null = null;
      constructor() { instance = this as never; }
      start() {}
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    vi.stubGlobal('webkitSpeechRecognition', FakeRecognition);
    useVoiceStore.setState({ channels: { C1: { ...SERVER, input: 'browser', language: 'de' } } });
    const onText = vi.fn();
    render(<MicButton channelId="C1" onText={onText} />);

    fireEvent.pointerDown(mic(), { button: 0, pointerId: 1 });
    expect(instance!.lang).toBe('de');
    act(() => instance!.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'erste Zeile ' } }, { isFinal: false, 0: { transcript: 'und mehr' } }] }));
    now += 2000;
    fireEvent.pointerUp(mic(), { pointerId: 1 });
    expect(onText).toHaveBeenCalledWith('erste Zeile und mehr');
    expect(transcribe).not.toHaveBeenCalled();
  });

  it('is hidden where voice input is off or the browser cannot record', () => {
    useVoiceStore.setState({ channels: { C1: { ...SERVER, input: 'off' } } });
    const { container, rerender } = render(<MicButton channelId="C1" onText={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    useVoiceStore.setState({ channels: { C1: { ...SERVER, input: 'browser' } } }); // no SpeechRecognition in jsdom
    rerender(<MicButton channelId="C1" onText={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
