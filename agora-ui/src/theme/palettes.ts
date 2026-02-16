// ─── Palette Definitions ─────────────────────────────────────────────────────
// Every color reference in Arc V2 goes through a palette object.
// See docs/design/arc-v2-spec.md for rationale and named colors.

export interface Palette {
  bg: string;
  surface: string;
  surfaceHover: string;
  primary: string;
  primaryHover: string;
  accent: string;
  text: string;
  white: string;
  muted: string;
  dim: string;
  border: string;
  online: string;
  danger: string;
  warn: string;
}

export const AEGEAN: Palette = {
  bg: '#241623',
  surface: '#332838',
  surfaceHover: '#3E3345',
  primary: '#0D5EAF',
  primaryHover: '#0B4E95',
  accent: '#0FA3B1',
  text: '#FDFFF7',
  white: '#FCFCFC',
  muted: '#A09AAB',
  dim: '#6E6479',
  border: '#3A2E3E',
  online: '#4ADE80',
  danger: '#EF4444',
  warn: '#FBBF24',
};

export const TERRACOTTA: Palette = {
  bg: '#1C1410',
  surface: '#2A2018',
  surfaceHover: '#362A20',
  primary: '#C2703E',
  primaryHover: '#A85F34',
  accent: '#D5FFF3',
  text: '#EBF5DF',
  white: '#FCFCFC',
  muted: '#9B8B7A',
  dim: '#6E5D4E',
  border: '#352820',
  online: '#4ADE80',
  danger: '#EF4444',
  warn: '#FBBF24',
};

export type PaletteKey = 'aegean' | 'terracotta';

export const PALETTES: Record<PaletteKey, Palette> = {
  aegean: AEGEAN,
  terracotta: TERRACOTTA,
};

export function hexToRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}
