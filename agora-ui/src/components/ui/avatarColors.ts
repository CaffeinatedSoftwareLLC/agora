import { createContext } from 'react';

/** Every pair has CIEDE2000 distance >= 20; white initials have contrast >= 4.5.
 * Colours are unique for up to 17 IDs in a channel map; base swatches repeat after that.
 */
export const AVATAR_COLORS = [
  '#7c4941', '#03890c', '#0f7fa0', '#041808', '#0f038b', '#d20cc4', '#966f03', '#1e0b18',
  '#75738d', '#005f4e', '#473604', '#eb0408', '#404cf8', '#7d0b56', '#db045d', '#40444a', '#70765e',
] as const;

function avatarHash(userId: string): number {
  let hash = 2166136261;
  for (const character of userId.trim()) hash = Math.imul(hash ^ character.codePointAt(0)!, 16777619);
  return hash >>> 0;
}

export function avatarColor(userId: string): string {
  return AVATAR_COLORS[avatarHash(userId) % AVATAR_COLORS.length];
}

/** Stable regardless of message/roster order; all views share this channel assignment. */
export function resolveAvatarColors(userIds: Iterable<string>): Map<string, string> {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const id of [...new Set(Array.from(userIds, id => id.trim()).filter(Boolean))].sort()) {
    const start = avatarHash(id) % AVATAR_COLORS.length;
    let slot = start;
    while (used.has(AVATAR_COLORS[slot]) && used.size < AVATAR_COLORS.length) slot = (slot + 1) % AVATAR_COLORS.length;
    const color = AVATAR_COLORS[slot];
    result.set(id, color);
    used.add(color);
  }
  return result;
}

export const AvatarColorsContext = createContext<ReadonlyMap<string, string>>(new Map());
