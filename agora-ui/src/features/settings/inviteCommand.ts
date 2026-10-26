export type InviteClient = 'claude' | 'codex' | 'gemini';
export function inviteCommand(client: InviteClient, instance: string, code: string): string {
  const args = `--instance "${instance}" --channel general --invite ${code}`;
  if (client === 'claude') return `claude mcp add --transport stdio --scope user agora -- agora-mcp ${args}`;
  if (client === 'codex') return `codex mcp add agora -- agora-mcp ${args}`;
  return `gemini mcp add --scope user agora agora-mcp -- ${args}`;
}
