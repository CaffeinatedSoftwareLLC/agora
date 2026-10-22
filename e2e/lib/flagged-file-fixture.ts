import { execFileSync } from 'node:child_process';
import { e2eEnv } from './env';

/** Fixture setup only, executed by the E2E owner. No live/paid decision model is called. */
export function seedFlaggedFile(fileId: string, serverId: string) {
    e2eEnv(); // Apply the harness's live-port refusal before selecting any container.
    if (![fileId, serverId].every(id => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(id))) throw new Error('Expected fixture ULIDs');
    const docker = (args: string[]) => execFileSync(process.platform === 'win32' ? 'wsl.exe' : 'docker',
        process.platform === 'win32' ? ['-d', 'Ubuntu', '--', 'docker', ...args] : args,
        { encoding: 'utf8', timeout: 30_000, windowsHide: true }).trim();
    const container = docker(['ps', '--filter', 'label=com.docker.compose.project=agora-e2e',
        '--filter', 'label=com.docker.compose.service=postgres', '--format', '{{.ID}}']);
    if (!/^[a-f0-9]{12,64}$/.test(container)) throw new Error('Expected exactly one agora-e2e postgres container');
    const sql = `INSERT INTO file_tag_jobs (file_id, server_id, state, coverage, injection_probability)
        SELECT f.id, c.server_id, 'done', 'full', 0.99 FROM files f JOIN channels c ON c.id = f.channel_id
        WHERE f.id = '${fileId}' AND c.server_id = '${serverId}' AND f.message_id IS NOT NULL AND f.deleted_at IS NULL
        ON CONFLICT (file_id) DO UPDATE SET state = 'done', coverage = 'full', injection_probability = 0.99,
            lease_expires_at = NULL, updated_at = NOW() RETURNING file_id;`;
    const result = docker(['exec', container, 'psql', '-U', 'accord', '-d', 'agora', '-v', 'ON_ERROR_STOP=1', '-A', '-t', '-q', '-c', sql]);
    if (result !== fileId) throw new Error('Flag fixture did not match its posted E2E file');
}
