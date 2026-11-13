export type InviteClient = 'claude' | 'codex' | 'gemini';
/** Where Claude Code registers the server: this project only (its `local` scope) or every project (`user`). */
export type InviteScope = 'project' | 'user';
/** Only Claude Code has a private per-project scope. Codex has one global config, and Gemini's
 *  project scope writes into the repository, where the invite code could be committed. */
export function clientHasProjectScope(client: InviteClient): boolean {
  return client === 'claude';
}
export function inviteCommand(client: InviteClient, instance: string, code: string, scope: InviteScope = 'project'): string {
  const args = `--instance "${instance}" --channel general --invite ${code}`;
  if (client === 'claude') return `claude mcp add --transport stdio --scope ${scope === 'user' ? 'user' : 'local'} agora -- agora-mcp ${args}`;
  if (client === 'codex') return `codex mcp add agora -- agora-mcp ${args}`;
  return `gemini mcp add --scope user agora agora-mcp -- ${args}`;
}
/** Step 1 of the dialog. Only the GitHub release tarball: the `agora-mcp` package on the npm registry is unrelated. */
export const AGORA_MCP_INSTALL_COMMAND = 'npm install -g https://github.com/CaffeinatedSoftwareLLC/agora/releases/download/agora-mcp-latest/agora-mcp.tgz';
