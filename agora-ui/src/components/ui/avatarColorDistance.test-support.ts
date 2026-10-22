type Lab = readonly [number, number, number];
const rad = (angle: number) => angle * Math.PI / 180;
const cos = (angle: number) => Math.cos(rad(angle));

export function hexToLab(hex: string): Lab {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const f = (v: number) => v > (6 / 29) ** 3 ? Math.cbrt(v) : v / (3 * (6 / 29) ** 2) + 4 / 29;
  const x = f((0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / 0.95047);
  const y = f(0.2126729 * r + 0.7151522 * g + 0.0721750 * b);
  const z = f((0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/** CIEDE2000 with the standard unit weighting factors. Test-only, never shipped. */
export function deltaE2000([l1, a1, b1]: Lab, [l2, a2, b2]: Lab): number {
  const meanC = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const g = 0.5 * (1 - Math.sqrt(meanC ** 7 / (meanC ** 7 + 25 ** 7)));
  const ap1 = (1 + g) * a1, ap2 = (1 + g) * a2;
  const c1 = Math.hypot(ap1, b1), c2 = Math.hypot(ap2, b2);
  const hue = (a: number, b: number) => (Math.atan2(b, a) * 180 / Math.PI + 360) % 360;
  const h1 = hue(ap1, b1), h2 = hue(ap2, b2);
  let dh = h2 - h1;
  if (!c1 || !c2) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dl = l2 - l1, dc = c2 - c1, dH = 2 * Math.sqrt(c1 * c2) * Math.sin(rad(dh / 2));
  const L = (l1 + l2) / 2, C = (c1 + c2) / 2;
  let H = (h1 + h2) / 2;
  if (!c1 || !c2) H = h1 + h2;
  else if (Math.abs(h1 - h2) > 180) H += h1 + h2 < 360 ? 180 : -180;
  const T = 1 - 0.17 * cos(H - 30) + 0.24 * cos(2 * H) + 0.32 * cos(3 * H + 6) - 0.20 * cos(4 * H - 63);
  const sl = 1 + 0.015 * (L - 50) ** 2 / Math.sqrt(20 + (L - 50) ** 2);
  const sc = 1 + 0.045 * C, sh = 1 + 0.015 * C * T;
  const rt = -2 * Math.sqrt(C ** 7 / (C ** 7 + 25 ** 7)) * Math.sin(rad(60 * Math.exp(-(((H - 275) / 25) ** 2))));
  return Math.sqrt((dl / sl) ** 2 + (dc / sc) ** 2 + (dH / sh) ** 2 + rt * dc / sc * dH / sh);
}
