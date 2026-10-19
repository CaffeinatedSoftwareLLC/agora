import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, voiceApi, type ChannelVoice } from '../../lib/api';
import { useVoiceStore } from './voiceStore';

/**
 * Push-to-talk (docs/voice.md). The server engine records with MediaRecorder and
 * sends the clip to the channel's Transcription route; the browser engine uses
 * the Web Speech API's SpeechRecognition where the admin allows it.
 */

export type VoiceInputState = 'idle' | 'recording' | 'transcribing';

/** Recorder formats in order of preference: Opus where supported, AAC (Safari) otherwise. */
const RECORDER_TYPES = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4'];
/** Clips shorter than this are taps, not speech. */
const MIN_CLIP_MS = 400;

interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionClass(): (new () => RecognitionLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function recorderSupported(): boolean {
  return typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

function recorderType(): string | undefined {
  return RECORDER_TYPES.find(t => MediaRecorder.isTypeSupported?.(t));
}

/** Whether this browser can do voice input with the given engine. */
export function voiceInputSupported(voice: ChannelVoice | null | undefined): boolean {
  if (!voice) return false;
  if (voice.input === 'server') return recorderSupported();
  if (voice.input === 'browser') return !!recognitionClass();
  return false;
}

function micError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was refused. Allow it in the browser’s site settings.';
  if (name === 'NotFoundError') return 'No microphone found.';
  if (err instanceof ApiError) return err.message || 'Transcription failed';
  return 'Could not use the microphone';
}

export function useVoiceInput(channelId: string, onText: (text: string) => void) {
  const voice = useVoiceStore(s => s.channels[channelId]);
  const loadChannel = useVoiceStore(s => s.loadChannel);
  const [state, setState] = useState<VoiceInputState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');

  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  /** False when the recording should be thrown away rather than transcribed. */
  const keepRef = useRef(true);
  /** Set while the microphone is being opened (a permission prompt may be up). */
  const startingRef = useRef(false);
  /** stop() came while starting: stop as soon as recording begins. */
  const pendingStopRef = useRef<boolean | null>(null);
  const onTextRef = useRef(onText);
  useEffect(() => { onTextRef.current = onText; }, [onText]);

  useEffect(() => {
    if (voice === undefined) void loadChannel(channelId);
  }, [channelId, voice, loadChannel]);

  const clearTimer = () => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const stop = useCallback((keep = true) => {
    if (startingRef.current) { pendingStopRef.current = keep; return; }
    keepRef.current = keep;
    clearTimer();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    else if (recognitionRef.current) {
      if (keep) recognitionRef.current.stop(); else recognitionRef.current.abort();
    }
  }, []);

  const start = useCallback(async () => {
    if (state !== 'idle' || startingRef.current || !voice || !voiceInputSupported(voice)) return;
    pendingStopRef.current = null;
    setError('');
    setElapsed(0);
    keepRef.current = true;
    const max = voice.maxRecordingSeconds;
    const tick = () => {
      const secs = Math.floor((Date.now() - startedAtRef.current) / 1000);
      setElapsed(secs);
      if (secs >= max) stop(true);
    };

    if (voice.input === 'browser') {
      const Recognition = recognitionClass()!;
      const rec = new Recognition();
      rec.lang = voice.language ?? navigator.language;
      rec.continuous = true;
      rec.interimResults = true;
      const finals: string[] = [];
      let interim = '';
      rec.onresult = (e) => {
        interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) finals.push(r[0].transcript.trim());
          else interim += r[0].transcript;
        }
      };
      rec.onerror = (e) => {
        if (e.error !== 'aborted' && e.error !== 'no-speech') setError(e.error === 'not-allowed' ? micError({ name: 'NotAllowedError' }) : `Speech recognition failed (${e.error})`);
      };
      rec.onend = () => {
        clearTimer();
        recognitionRef.current = null;
        setState('idle');
        const text = [...finals, interim.trim()].filter(Boolean).join(' ');
        if (keepRef.current && text) onTextRef.current(text);
      };
      recognitionRef.current = rec;
      startedAtRef.current = Date.now();
      try { rec.start(); } catch (err) { recognitionRef.current = null; setError(micError(err)); return; }
      setState('recording');
      timerRef.current = window.setInterval(tick, 250);
      return;
    }

    let stream: MediaStream;
    startingRef.current = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      setError(micError(err));
      return;
    } finally {
      startingRef.current = false;
    }
    const type = recorderType();
    const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      recorderRef.current = null;
      const duration = Date.now() - startedAtRef.current;
      if (!keepRef.current || duration < MIN_CLIP_MS || chunks.length === 0) { setState('idle'); return; }
      setState('transcribing');
      try {
        const clip = new Blob(chunks, { type: (recorder.mimeType || type || 'audio/webm').split(';')[0] });
        const text = await voiceApi.transcribe(channelId, clip);
        if (text) onTextRef.current(text);
        else setError('No speech was heard.');
      } catch (err) {
        setError(micError(err));
      } finally {
        setState('idle');
      }
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    recorder.start(1000);
    setState('recording');
    timerRef.current = window.setInterval(tick, 250);
    if (pendingStopRef.current !== null) stop(pendingStopRef.current);
  }, [state, voice, channelId, stop]);

  // Leaving the channel (or the composer) mid-recording throws the clip away
  useEffect(() => () => {
    keepRef.current = false;
    clearTimer();
    if (recorderRef.current && recorderRef.current.state !== 'inactive') recorderRef.current.stop();
    recognitionRef.current?.abort();
  }, [channelId]);

  return {
    available: voiceInputSupported(voice),
    maxSeconds: voice?.maxRecordingSeconds ?? 0,
    state,
    elapsed,
    error,
    clearError: () => setError(''),
    start,
    stop,
  };
}
