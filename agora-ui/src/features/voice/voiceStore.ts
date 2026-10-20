import { create } from 'zustand';
import { api, voiceApi, type ChannelVoice } from '../../lib/api';
import { useMemberStore } from '../../stores/memberStore';
import { speakableText } from './speakable';

/**
 * Read-aloud (docs/voice.md): what each channel's server allows, the person's
 * preference, and one playback queue. The server's Speech route returns MP3 that
 * plays through a single <audio> element; the browser engine uses speechSynthesis
 * with an on-device voice where there is one.
 */

/** Read agents' new replies aloud: never, on phones (touch screens), or everywhere. */
export type ReadAloudPref = 'off' | 'phone' | 'all';

export interface Speakable {
  id: string;
  channelId: string;
  content: string | null;
}

interface VoiceState {
  readAloud: ReadAloudPref;
  /** Save the preference to the account (shared by the person's devices). */
  setReadAloud: (pref: ReadAloudPref) => void;
  /** Apply the saved preference after sign-in. */
  applyPreference: (value: unknown) => void;

  /** Per channel: which engines its server allows (null while unknown or refused). */
  channels: Record<string, ChannelVoice | null>;
  loadChannel: (channelId: string) => Promise<ChannelVoice | null>;

  /** The message being read, if any. */
  speaking: string | null;
  error: string | null;
  /** Read a message now, interrupting anything playing. */
  speak: (message: Speakable) => void;
  /** Queue a newly arrived agent reply if the person asked for automatic reading here. */
  autoRead: (message: Speakable) => void;
  stop: () => void;
}

const isPref = (v: unknown): v is ReadAloudPref => v === 'off' || v === 'phone' || v === 'all';

/** Phones and tablets: a touch screen is the main pointer. */
export function isPhoneLike(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches;
}

// ─── Playback ───

const queue: Speakable[] = [];
let audio: HTMLAudioElement | null = null;
/** Voiced messages by id and text (object URLs), so a replay needs no second request. */
const clips = new Map<string, string>();
const clipKey = (m: Speakable) => `${m.id}\u0000${m.content ?? ''}`;
const MAX_CLIPS = 20;
/** Bumped by every new speak/stop so a late response doesn't start playing. */
let generation = 0;

function audioElement(): HTMLAudioElement {
  if (!audio) audio = new Audio();
  return audio;
}

function rememberClip(id: string, url: string) {
  clips.set(id, url);
  for (const [key, old] of clips) {
    if (clips.size <= MAX_CLIPS) break;
    clips.delete(key);
    URL.revokeObjectURL(old);
  }
}

function memberNames(): Map<string, string> {
  const names = new Map<string, string>();
  for (const members of useMemberStore.getState().byServer.values()) for (const m of members) names.set(m.id, m.username);
  return names;
}

/** A local voice in the page's language, if the browser has one; otherwise its default. */
function pickVoice(lang: string | null): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  const want = (lang ?? navigator.language ?? 'en').toLowerCase().split('-')[0];
  const sameLang = voices.filter(v => v.lang.toLowerCase().startsWith(want));
  return sameLang.find(v => v.localService && v.default) ?? sameLang.find(v => v.localService) ?? sameLang[0];
}

export function browserSpeechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';
}

/** 0.05 s of silence as a WAV data URL (8 kHz, 8-bit mono). */
function silentWav(): string {
  const samples = 400;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + samples, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  ascii(36, 'data'); view.setUint32(40, samples, true);
  bytes.fill(128, 44); // 8-bit silence is the midpoint
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
}

/**
 * Phones only play sound that a tap started. Call from a tap (the read-aloud
 * switch, a Read aloud button, the microphone) so later automatic reads may play.
 */
export function primeAudio() {
  try {
    const el = audioElement();
    if (!el.src) {
      el.src = silentWav();
      void el.play().catch(() => {});
    }
    if (browserSpeechSupported() && !window.speechSynthesis.speaking) {
      const u = new SpeechSynthesisUtterance('');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    }
  } catch { /* nothing to prime */ }
}

export const useVoiceStore = create<VoiceState>((set, get) => {
  const finish = (gen: number) => {
    if (gen !== generation) return;
    set({ speaking: null });
    const next = queue.shift();
    if (next) void play(next);
  };

  async function play(message: Speakable) {
    const gen = ++generation;
    const voice = get().channels[message.channelId] ?? await get().loadChannel(message.channelId);
    if (gen !== generation) return;
    if (!voice || voice.output === 'off' || !message.content?.trim()) { finish(gen); return; }
    set({ speaking: message.id, error: null });

    if (voice.output === 'server') {
      try {
        let url = clips.get(clipKey(message));
        if (!url) {
          url = URL.createObjectURL(await voiceApi.speech(message.channelId, message.id));
          rememberClip(clipKey(message), url);
        }
        if (gen !== generation) return;
        const el = audioElement();
        el.onended = () => finish(gen);
        el.onerror = () => finish(gen);
        el.src = url;
        await el.play();
      } catch (err) {
        if (gen !== generation) return;
        set({ error: err instanceof Error && err.message !== 'speech_failed' ? err.message : 'Could not read the message aloud' });
        finish(gen);
      }
      return;
    }

    if (!browserSpeechSupported()) { finish(gen); return; }
    const text = speakableText(message.content, voice.maxChars, memberNames());
    if (!text) { finish(gen); return; }
    const utterance = new SpeechSynthesisUtterance(text);
    const local = pickVoice(voice.language);
    if (local) { utterance.voice = local; utterance.lang = local.lang; }
    utterance.onend = () => finish(gen);
    utterance.onerror = () => finish(gen);
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }

  function silence() {
    generation++;
    queue.length = 0;
    if (audio) { audio.onended = null; audio.onerror = null; audio.pause(); }
    if (browserSpeechSupported()) window.speechSynthesis.cancel();
  }

  return {
    readAloud: 'off',
    setReadAloud: (pref) => {
      set({ readAloud: pref });
      if (pref === 'off') get().stop();
      else primeAudio();
      api.patch('/users/@me/preferences', { readAloud: pref }).catch(() => { /* offline or older server */ });
    },
    applyPreference: (value) => {
      if (isPref(value)) set({ readAloud: value });
    },

    channels: {},
    loadChannel: async (channelId) => {
      try {
        const voice = await voiceApi.forChannel(channelId);
        set(s => ({ channels: { ...s.channels, [channelId]: voice } }));
        return voice;
      } catch {
        // Older server, or not allowed: no voice here
        set(s => ({ channels: { ...s.channels, [channelId]: null } }));
        return null;
      }
    },

    speaking: null,
    error: null,
    speak: (message) => {
      silence();
      set({ speaking: null, error: null });
      void play(message);
    },
    autoRead: (message) => {
      const pref = get().readAloud;
      if (pref === 'off' || (pref === 'phone' && !isPhoneLike())) return;
      // Nothing to say: empty, or a placeholder such as the assistant's "..." before it streams
      if (!/[\p{L}\p{N}]/u.test(message.content ?? '')) return;
      if (get().speaking || queue.length > 0) {
        if (!queue.some(m => m.id === message.id) && get().speaking !== message.id) queue.push(message);
        return;
      }
      void play(message);
    },
    stop: () => {
      silence();
      set({ speaking: null });
    },
  };
});
