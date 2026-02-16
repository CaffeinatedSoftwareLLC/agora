import { useUIStore } from '../stores/uiStore';
import { PALETTES, type Palette } from './palettes';

export function usePalette(): Palette {
  const paletteKey = useUIStore(s => s.paletteKey);
  return PALETTES[paletteKey];
}
