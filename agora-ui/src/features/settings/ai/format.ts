import type { AICapability } from '../../../lib/api';

export const CAPABILITY_INFO: Record<AICapability, { label: string; description: string }> = {
  chat: { label: 'Chat', description: 'Built-in assistant replies in channels and threads' },
  search: { label: 'Search', description: 'Grounded web search with citations' },
  image: { label: 'Image', description: 'Image generation' },
  tts: { label: 'Speech', description: 'Text-to-speech (audio overviews)' },
  video: { label: 'Video', description: 'Video generation' },
  decide: { label: 'Decide', description: 'Fast typed decisions (routing, risk gating)' },
};

export const CAPABILITY_ORDER: AICapability[] = ['chat', 'search', 'image', 'tts', 'video', 'decide'];

/** micro-USD → "$0.0042" (4 decimals under $1, else 2). */
export function formatMicros(micros: number | null | undefined): string {
  if (micros === null || micros === undefined) return '—';
  const dollars = micros / 1_000_000;
  return `$${dollars.toFixed(dollars < 1 ? 4 : 2)}`;
}

/** "1.50" dollars → 1500000 micros; blank → null. Returns undefined when invalid. */
export function dollarsToMicros(input: string): number | null | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000_000);
}

export function microsToDollars(micros: number | null): string {
  return micros === null ? '' : String(micros / 1_000_000);
}

/** Positive integer or blank → number | null; undefined when invalid. */
export function parseLimit(input: string): number | null | undefined {
  const trimmed = input.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < 1) return undefined;
  return value;
}

export const inputClass =
  'bg-surface border border-border rounded px-3 py-2 text-text placeholder-text-dim focus:outline-none focus:ring-2 focus:ring-primary';
