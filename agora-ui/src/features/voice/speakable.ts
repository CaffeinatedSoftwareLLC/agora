/**
 * Markdown → text worth hearing, for the browser's own voices. A mirror of
 * `speakableText` in src/ai/voice.ts (the server's Speech route reads with that
 * one); keep the two in step. Code blocks and URLs are named, not read out;
 * formatting marks are dropped; lines become sentences; long text is cut.
 */

const MENTION = /<@([0-9A-HJKMNP-TV-Z]{26})>/g;

export function speakableText(markdown: string, maxChars: number, names: Map<string, string> = new Map()): string {
  let text = markdown
    .replace(/```[\s\S]*?(```|$)/g, '\n(code block)\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => alt ? `(image: ${alt})` : '(image)')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '(link)')
    .replace(MENTION, (_, id: string) => `@${names.get(id) ?? 'someone'}`)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '');

  const lines = text.split('\n').map(line => line
    .replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '')                 // horizontal rule
    .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/, '')   // table rule
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
    .split('|').map(cell => cell.trim()).filter(Boolean).join(', ')
    .replace(/(\*\*|~~)(?=\S)(.+?)\1/g, '$2')
    .replace(/\*(?=\S)([^*]+?)\*/g, '$1')
    // _emphasis_ only at word edges, so snake_case names keep their underscores
    .replace(/(^|\W)(__?)(?=\S)(.+?)\2(?=\W|$)/g, '$1$3')
    .replace(/\s+/g, ' ')
    .trim())
    .filter(Boolean);
  text = lines.map(l => /[.!?:;…]$/.test(l) ? l : `${l}.`).join(' ');

  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  const end = sentence > maxChars / 2 ? sentence + 1 : Math.max(cut.lastIndexOf(' '), maxChars / 2);
  return `${cut.slice(0, end).trim()} The rest is in the message.`;
}
