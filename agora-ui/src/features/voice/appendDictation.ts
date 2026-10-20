/** Add dictated text to a draft: after what is there, separated by one space. */
export function appendDictation(draft: string, text: string): string {
  const spoken = text.trim();
  if (!spoken) return draft;
  return draft.trim() ? `${draft.replace(/\s+$/, '')} ${spoken}` : spoken;
}
