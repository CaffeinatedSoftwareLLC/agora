import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelVoice } from '../../lib/api';

vi.hoisted(() => { vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn(), removeItem: vi.fn() }); });
const patch = vi.hoisted(() => vi.fn(async () => ({})));
const forChannel = vi.hoisted(() => vi.fn());
const speech = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api', async orig => {
  const actual = await orig<typeof import('../../lib/api')>();
  return {
    ...actual,
    api: { ...actual.api, patch: (...args: unknown[]) => patch(...(args as [])) },
    voiceApi: { ...actual.voiceApi, forChannel: (id: string) => forChannel(id), speech: (c: string, m: string) => speech(c, m) },
  };
});

import { useVoiceStore } from './voiceStore';

const SERVER: ChannelVoice = { input: 'server', output: 'server', maxRecordingSeconds: 60, language: null, maxChars: 1500 };
const BROWSER: ChannelVoice = { ...SERVER, output: 'browser', language: 'en' };

/** A fake <audio>: play() resolves, and `end()` finishes the current clip. */
class FakeAudio {
  static last: FakeAudio | null = null;
  src = '';
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  played: string[] = [];
  constructor() { FakeAudio.last = this; }
  play = vi.fn(async () => { this.played.push(this.src); });
  pause = vi.fn();
  end() { this.onended?.(); }
}

const spoken: { text: string; voice?: { name: string } | null; onend?: () => void }[] = [];

function coarsePointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)' && coarse }));
  window.matchMedia = (q: string) => ({ matches: q === '(pointer: coarse)' && coarse }) as MediaQueryList;
}

const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio);
  // The store keeps one <audio> element for the page
  if (FakeAudio.last) FakeAudio.last.played = [];
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => `blob:clip-${++n}`), revokeObjectURL: vi.fn() }));
  vi.stubGlobal('SpeechSynthesisUtterance', class { text: string; voice: unknown = null; lang = ''; volume = 1; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(t: string) { this.text = t; } });
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      speaking: false,
      getVoices: () => [{ name: 'Cloud', lang: 'en-US', localService: false, default: true }, { name: 'Local', lang: 'en-GB', localService: true, default: false }],
      speak: vi.fn((u: { text: string; voice: { name: string } | null; onend: () => void }) => { if (u.text) spoken.push(u); }),
      cancel: vi.fn(),
    },
  });
  useVoiceStore.setState({ readAloud: 'off', channels: { C1: SERVER, C2: BROWSER }, speaking: null, error: null });
});

afterEach(() => {
  useVoiceStore.getState().stop();
  spoken.length = 0;
  speech.mockReset();
  forChannel.mockReset();
  patch.mockClear();
  vi.unstubAllGlobals();
});

describe('read-aloud preference', () => {
  it('saves the choice to the account and applies a saved one', () => {
    useVoiceStore.getState().setReadAloud('phone');
    expect(useVoiceStore.getState().readAloud).toBe('phone');
    expect(patch).toHaveBeenCalledWith('/users/@me/preferences', { readAloud: 'phone' });
    useVoiceStore.getState().applyPreference('all');
    expect(useVoiceStore.getState().readAloud).toBe('all');
    useVoiceStore.getState().applyPreference('loud');
    expect(useVoiceStore.getState().readAloud).toBe('all');
  });

  it('skips placeholders with nothing to say', async () => {
    useVoiceStore.setState({ readAloud: 'all' });
    useVoiceStore.getState().autoRead({ id: 'Q1', channelId: 'C1', content: '...' });
    useVoiceStore.getState().autoRead({ id: 'Q2', channelId: 'C1', content: '  ' });
    await flush();
    expect(speech).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().speaking).toBeNull();
  });

  it('reads new replies automatically only where the person asked for it', async () => {
    speech.mockResolvedValue(new Blob(['mp3'], { type: 'audio/mpeg' }));
    const msg = { id: 'M1', channelId: 'C1', content: 'Done.' };

    useVoiceStore.getState().autoRead(msg);
    coarsePointer(false);
    useVoiceStore.setState({ readAloud: 'phone' });
    useVoiceStore.getState().autoRead(msg);
    await flush();
    expect(speech).not.toHaveBeenCalled();

    coarsePointer(true);
    useVoiceStore.getState().autoRead(msg);
    await flush();
    expect(speech).toHaveBeenCalledWith('C1', 'M1');
    expect(useVoiceStore.getState().speaking).toBe('M1');
  });
});

describe('playback', () => {
  it('plays the server voice, queues later replies, and replays from memory', async () => {
    speech.mockImplementation(async (_c: string, m: string) => new Blob([m], { type: 'audio/mpeg' }));
    useVoiceStore.setState({ readAloud: 'all' });
    useVoiceStore.getState().autoRead({ id: 'P1', channelId: 'C1', content: 'one' });
    await flush();
    useVoiceStore.getState().autoRead({ id: 'P2', channelId: 'C1', content: 'two' });
    useVoiceStore.getState().autoRead({ id: 'P2', channelId: 'C1', content: 'two' }); // duplicates are ignored
    await flush();
    const el = FakeAudio.last!;
    expect(el.played.filter(src => src.startsWith('blob:'))).toEqual(['blob:clip-1']);

    el.end();
    await flush();
    expect(el.played.filter(src => src.startsWith('blob:'))).toEqual(['blob:clip-1', 'blob:clip-2']);
    expect(useVoiceStore.getState().speaking).toBe('P2');
    el.end();
    await flush();
    expect(useVoiceStore.getState().speaking).toBeNull();

    // Read aloud again: no second request
    useVoiceStore.getState().speak({ id: 'P1', channelId: 'C1', content: 'one' });
    await flush();
    expect(speech).toHaveBeenCalledTimes(2);
    expect(el.played.at(-1)).toBe('blob:clip-1');
  });

  it('stops and clears the queue', async () => {
    speech.mockResolvedValue(new Blob(['x']));
    useVoiceStore.setState({ readAloud: 'all' });
    useVoiceStore.getState().autoRead({ id: 'S1', channelId: 'C1', content: 'one' });
    useVoiceStore.getState().autoRead({ id: 'S2', channelId: 'C1', content: 'two' });
    await flush();
    useVoiceStore.getState().stop();
    expect(useVoiceStore.getState().speaking).toBeNull();
    FakeAudio.last!.end();
    await flush();
    expect(FakeAudio.last!.played.filter(src => src.startsWith('blob:'))).toHaveLength(1);
  });

  it('shows why the server voice failed', async () => {
    const { ApiError } = await import('../../lib/api');
    speech.mockRejectedValue(new ApiError(429, 'Daily request limit reached for "tts" (50/day)'));
    useVoiceStore.getState().speak({ id: 'E1', channelId: 'C1', content: 'one' });
    await flush();
    expect(useVoiceStore.getState().error).toContain('Daily request limit');
    expect(useVoiceStore.getState().speaking).toBeNull();
  });

  it('uses an on-device browser voice with speakable text when the server has no voice', async () => {
    useVoiceStore.getState().speak({ id: 'M3', channelId: 'C2', content: '**Done**, see https://x.dev' });
    await flush();
    expect(speech).not.toHaveBeenCalled();
    expect(spoken).toHaveLength(1);
    expect(spoken[0].text).toBe('Done, see (link).');
    expect(spoken[0].voice?.name).toBe('Local');
    spoken[0].onend?.();
    expect(useVoiceStore.getState().speaking).toBeNull();
  });

  // beta-test-plan §6.4 "Text length": a 5,000-character message read with a 1,500 limit
  it('reads a 5,000-character message cut at a sentence within the limit, saying the rest is in the message', async () => {
    const sentences = Array.from({ length: 200 }, (_, i) => `Step ${String(i).padStart(3, '0')} of the plan is done.`);
    const content = sentences.join(' ').slice(0, 5000);
    expect(content.length).toBe(5000);
    useVoiceStore.setState({ channels: { C1: SERVER, C2: { ...BROWSER, maxChars: 1500 } } });
    useVoiceStore.getState().speak({ id: 'L1', channelId: 'C2', content });
    await flush();
    expect(speech).not.toHaveBeenCalled();
    expect(spoken).toHaveLength(1);
    const text = spoken[0].text;
    const SUFFIX = ' The rest is in the message.';
    expect(text.endsWith(`is done.${SUFFIX}`)).toBe(true);
    const body = text.slice(0, -SUFFIX.length);
    expect(body.length).toBeLessThanOrEqual(1500);
    expect(body.length).toBeGreaterThan(1000);
    expect(content.startsWith(body)).toBe(true);
  });

  it('loads the channel’s engines when it does not know them yet, and stays quiet where voice is off', async () => {
    forChannel.mockResolvedValue({ ...SERVER, output: 'off' });
    useVoiceStore.getState().speak({ id: 'M4', channelId: 'C9', content: 'hi' });
    await flush();
    expect(forChannel).toHaveBeenCalledWith('C9');
    expect(speech).not.toHaveBeenCalled();
    expect(useVoiceStore.getState().channels.C9).toMatchObject({ output: 'off' });
  });
});
