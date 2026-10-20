import { describe, expect, it } from 'vitest';
import {
    AutostartDeps, ExecResult, autostartCommand, assertSafePath, launchAgentPlist, parseSchtasksList, planFor, statusOf, systemdUnit, windowsLauncher, windowsTaskXml,
} from '../src/autostart.js';

type Call = [string, string[]];
function harness(platform: NodeJS.Platform, opts: { replies?: Record<string, Partial<ExecResult>>; files?: Record<string, string | Buffer>; uid?: number; config?: string; elevated?: boolean } = {}) {
    const calls: Call[] = [];
    const files: Record<string, string | Buffer> = { ...(opts.files ?? {}) };
    const win = platform === 'win32';
    const config = opts.config ?? (win ? 'C:\\Users\\me\\agora\\host.json' : '/home/me/agora/host.json');
    files[config] ??= '{}';
    const deps: AutostartDeps = {
        platform, homedir: win ? 'C:\\Users\\me' : '/home/me', nodePath: win ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node',
        entryPath: win ? 'C:\\src\\agora-host\\dist\\index.js' : '/src/agora-host/dist/index.js',
        uid: opts.uid ?? 1000, env: { USERNAME: 'me', USERDOMAIN: 'PC', PATH: '/usr/bin:/bin' },
        exec: async (file, args) => {
            calls.push([file, args]);
            if (file === 'whoami') return { code: 0, stdout: opts.elevated ? 'S-1-16-12288' : 'S-1-16-8192', stderr: '' };
            const key = `${file} ${args.join(' ')}`;
            const hit = Object.entries(opts.replies ?? {}).find(([k]) => key.startsWith(k));
            return { code: 0, stdout: '', stderr: '', ...(hit?.[1] ?? {}) };
        },
        fs: {
            access: async (f: any) => { if (!(f in files)) throw new Error('ENOENT'); },
            mkdir: async () => undefined,
            readFile: (async (f: any) => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; }) as any,
            writeFile: (async (f: any, d: any) => { files[f] = d; }) as any,
            rm: (async (f: any) => { delete files[f]; }) as any,
        },
    };
    const lines: string[] = [];
    return { deps, calls, files, config, lines, run: (argv: string[]) => autostartCommand(argv, l => lines.push(l), deps) };
}

describe('argument and path safety', () => {
    it('rejects quotes, newlines and cmd metacharacters', () => {
        expect(() => assertSafePath('p', 'C:\\a"b', 'win32')).toThrow();
        expect(() => assertSafePath('p', '/a\nb', 'linux')).toThrow();
        expect(() => assertSafePath('p', 'C:\\a&calc', 'win32')).toThrow();
        expect(() => assertSafePath('p', 'C:\\a%PATH%', 'win32')).toThrow();
        expect(() => assertSafePath('p', 'C:\\Program Files\\a b', 'win32')).not.toThrow();
        expect(() => assertSafePath('p', '/home/a b', 'linux')).not.toThrow();
    });
    it('refuses relative, missing and unsafe configs, and root', async () => {
        const h = harness('linux');
        expect(await h.run(['enable', '--config', 'host.json'])).toBe(1);
        expect(h.lines.join()).toMatch(/absolute/);
        expect(await harness('linux').run(['enable', '--config', '/nope/host.json'])).toBe(1);
        const bad = harness('linux', { config: '/home/me/a"b/host.json' });
        expect(await bad.run(['enable', '--config', bad.config])).toBe(1);
        expect(bad.calls).toHaveLength(0);
        const root = harness('linux', { uid: 0 });
        expect(await root.run(['enable', '--config', root.config])).toBe(1);
        expect(root.calls).toHaveLength(0);
        const adm = harness('win32', { elevated: true });
        expect(await adm.run(['enable', '--config', adm.config])).toBe(1);
        expect(adm.calls.some(c => c[0] === 'schtasks')).toBe(false);
    });
    it('prints usage for unknown actions', async () => {
        const h = harness('linux');
        expect(await h.run(['bogus'])).toBe(2);
    });
});

describe('Windows', () => {
    it('generates a hidden per-user task with restart on failure', () => {
        const h = harness('win32');
        const p = planFor(h.deps, h.config);
        const xml = windowsTaskXml(p, 'PC\\me', 'C:\\Users\\me\\agora\\agora-host-autostart.vbs');
        expect(xml).toContain('<LogonTrigger>');
        expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
        expect(xml).toContain('<Hidden>true</Hidden>');
        expect(xml).toContain('<RestartOnFailure>');
        expect(xml).toContain('<WorkingDirectory>C:\\src\\agora-host</WorkingDirectory>');
        const vbs = windowsLauncher(p);
        expect(vbs).toContain('host.log');
        expect(vbs).toContain('host.err.log');
        expect(vbs).toContain('""C:\\Program Files\\nodejs\\node.exe"" ""C:\\src\\agora-host\\dist\\index.js"" --config ""C:\\Users\\me\\agora\\host.json""');
        expect(vbs).toContain('sh.CurrentDirectory = "C:\\src\\agora-host"');
    });
    it('enable registers via schtasks with an args array, then starts; re-enable is safe', async () => {
        const h = harness('win32', { replies: { 'schtasks /Query': { code: 1 } } });
        expect(await h.run(['enable', '--config', h.config])).toBe(0);
        const create = h.calls.find(c => c[1][0] === '/Create')!;
        expect(create[0]).toBe('schtasks');
        expect(create[1].slice(0, 3)).toEqual(['/Create', '/TN', 'AgoraHost']);
        expect(create[1]).toContain('/F');
        expect(h.calls.some(c => c[1][0] === '/Run')).toBe(true);
        expect(Object.keys(h.files).some(f => f.endsWith('agora-host-task.xml'))).toBe(false);
        expect(Object.keys(h.files).some(f => f.endsWith('agora-host-autostart.vbs'))).toBe(true);
        const running = harness('win32', { replies: { 'schtasks /Query': { stdout: 'Status:  Running\nTask To Run: wscript.exe //B x' } } });
        expect(await running.run(['enable', '--config', running.config])).toBe(0);
        expect(running.calls.some(c => c[1][0] === '/Run')).toBe(false);
    });
    it('parses status and disables cleanly, also when absent', async () => {
        expect(parseSchtasksList('Folder: \\\r\nStatus:                                Ready\r\nTask To Run:                          wscript.exe //B "C:\\x\\agora-host-autostart.vbs"\r\n'))
            .toEqual({ status: 'Ready', run: 'wscript.exe //B "C:\\x\\agora-host-autostart.vbs"' });
        const vbs = 'C:\\Users\\me\\agora\\agora-host-autostart.vbs';
        const h = harness('win32', { files: { [vbs]: 'x' }, replies: { 'schtasks /Query': { stdout: `Status: Running\nTask To Run: wscript.exe //B //Nologo "${vbs}"` } } });
        expect(await h.run(['status', '--config', h.config])).toBe(0);
        expect(h.lines).toContain('running: yes');
        expect(await h.run(['disable'])).toBe(0);
        expect(h.calls.some(c => c[1][0] === '/Delete')).toBe(true);
        expect(vbs in h.files).toBe(false);
        const none = harness('win32', { replies: { 'schtasks /Query': { code: 1 } } });
        expect(await none.run(['disable'])).toBe(0);
        expect(none.calls.some(c => c[1][0] === '/Delete')).toBe(false);
    });
});

describe('Linux', () => {
    const unitFile = '/home/me/.config/systemd/user/agora-host.service';
    it('generates a user unit with quoted ExecStart and Restart=on-failure', () => {
        const h = harness('linux', { config: '/home/me/my agora/host.json' });
        const u = systemdUnit(planFor(h.deps, h.config), '/usr/bin:/bin');
        expect(u).toContain('ExecStart="/usr/bin/node" "/src/agora-host/dist/index.js" --config "/home/me/my agora/host.json"');
        expect(u).toContain('Restart=on-failure');
        expect(u).toContain('WorkingDirectory=/src/agora-host');
        expect(u).toContain('StandardOutput=append:/home/me/my agora/host.log');
        expect(u).toContain('StandardError=append:/home/me/my agora/host.err.log');
        expect(u).toContain('WantedBy=default.target');
        expect(systemdUnit(planFor({ ...h.deps, nodePath: '/opt/100%/node$x' }, h.config))).toContain('"/opt/100%%/node$$x"');
    });
    it('enable writes the unit and runs systemctl --user; unchanged re-enable skips restart', async () => {
        const h = harness('linux');
        expect(await h.run(['enable', '--config', h.config])).toBe(0);
        expect(h.files[unitFile]).toContain('Restart=on-failure');
        expect(h.calls.map(c => c[1].join(' '))).toEqual(['--user daemon-reload', '--user enable --now agora-host.service', '--user restart agora-host.service']);
        h.calls.length = 0;
        expect(await h.run(['enable', '--config', h.config])).toBe(0);
        expect(h.calls.map(c => c[1].join(' '))).toEqual(['--user daemon-reload', '--user enable --now agora-host.service']);
    });
    it('status parses systemctl show; disable removes the unit', async () => {
        const h = harness('linux', { replies: { 'systemctl --user show': { stdout: 'LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n' } } });
        expect(await h.run(['enable', '--config', h.config])).toBe(0);
        const s = await statusOf(h.deps);
        expect(s).toMatchObject({ installed: true, enabled: true, running: true });
        expect(s.command).toContain('"/usr/bin/node"');
        expect(await h.run(['disable'])).toBe(0);
        expect(unitFile in h.files).toBe(false);
        expect(h.calls.some(c => c[1].join(' ') === '--user disable --now agora-host.service')).toBe(true);
        expect(await h.run(['disable'])).toBe(0);
        const gone = harness('linux', { replies: { 'systemctl --user show': { stdout: 'LoadState=not-found\nActiveState=inactive\nUnitFileState=\n' } } });
        expect(await statusOf(gone.deps)).toMatchObject({ installed: false, enabled: false, running: false });
    });
});

describe('macOS', () => {
    const plist = '/home/me/Library/LaunchAgents/com.agora.host.plist';
    it('generates a KeepAlive LaunchAgent with escaped arguments', () => {
        const h = harness('darwin', { config: '/Users/a&b/host.json' });
        const x = launchAgentPlist(planFor(h.deps, h.config), '/usr/bin:/bin');
        expect(x).toContain('<key>KeepAlive</key><true/>');
        expect(x).toContain('<key>RunAtLoad</key><true/>');
        expect(x).toContain('<string>/Users/a&amp;b/host.json</string>');
        expect(x).toContain('<string>--config</string>');
        expect(x).toContain('<key>WorkingDirectory</key><string>/src/agora-host</string>');
        expect(x).toContain('host.err.log');
    });
    it('enable boots out then bootstraps gui/<uid>; disable removes the plist', async () => {
        const h = harness('darwin', { uid: 501, replies: { 'launchctl bootout': { code: 113 } } });
        expect(await h.run(['enable', '--config', h.config])).toBe(0);
        expect(h.calls.map(c => c[1].join(' '))).toEqual(['bootout gui/501/com.agora.host', `bootstrap gui/501 ${plist}`]);
        expect(plist in h.files).toBe(true);
        expect(await h.run(['disable'])).toBe(0);
        expect(plist in h.files).toBe(false);
        expect(await h.run(['disable'])).toBe(0);
    });
    it('status parses launchctl print', async () => {
        const h = harness('darwin', { uid: 501, replies: { 'launchctl print': { stdout: 'com.agora.host = {\n\tstate = running\n}' } } });
        await h.run(['enable', '--config', h.config]);
        const s = await statusOf(h.deps);
        expect(s).toMatchObject({ installed: true, enabled: true, running: true });
        expect(s.command).toBe(`/usr/bin/node /src/agora-host/dist/index.js --config ${h.config}`);
    });
});
