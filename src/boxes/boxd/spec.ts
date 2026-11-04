import type { ContainerCreateOptions } from 'dockerode';
import {
    BOX_HOME, BOX_UID, EDGE_AGORA_PORT, EDGE_HOSTNAME, EDGE_PROXY_PORT,
    LABEL_BOX, LABEL_BOX_GENERATION, LABEL_BOX_VERSION, LABEL_INSTANCE,
    boxContainerName, boxNetworkName, boxVolumeName,
} from '../../lib/boxes/contract';
import { boxAddress, edgeAddress, gatewayAddress } from './subnets';

/**
 * The Docker create bodies for one box (docs/agent-boxes.md §7.1), and the check boxd runs
 * before every start (§7.2).
 *
 * Everything security-relevant is a constant here. The box row supplies only its ID,
 * generation, subnet and clamped limits; the tokens and profile come from boxd itself.
 * Nothing a person or a box sends reaches Docker as a flag, a mount or a capability.
 */

export const BOX_USER = `${BOX_UID}:${BOX_UID}`;
export const RUN_AGORA_DIR = '/run/agora';
export const TMPFS: Record<string, string> = {
    // Builds and package managers run things from /tmp, so it stays exec
    '/tmp': 'rw,nosuid,nodev,size=1g,mode=1777',
    // agora-host's config with the tokens (§8.1); readable by the box user only
    [RUN_AGORA_DIR]: `rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=${BOX_UID},gid=${BOX_UID}`,
};
export const STOP_TIMEOUT_SECONDS = 30;

/** Instance ceilings: the DB checks allow more, boxd never creates beyond these. */
export const LIMIT_CEILINGS = { cpus: 16, memoryMb: 65536, pids: 16384 };

export interface BoxLimits { cpus: number; memoryMb: number; pids: number }

export interface BoxProfileEnv {
    name: string;
    adapter: 'claude' | 'codex';
    auth: 'subscription' | 'api_key';
    apiKeyEnv: string | null;
    workdirAlias: 'work';
    repos: string[];
}

export interface BoxSpecInput {
    instance: string;
    boxId: string;
    generation: number;
    image: string;
    imageVersion: number;
    runtime: 'runsc' | 'runc';
    subnet: string;
    limits: BoxLimits;
    hostToken: string;
    botId: string;
    botToken: string;
    profile: BoxProfileEnv;
    /** api_key profiles: the provider key, under profile.apiKeyEnv */
    apiKey: string | null;
}

/** A provider key variable: `<NAME>_API_KEY`, never one of Agora's own or the proxy's. */
export const API_KEY_ENV = /^[A-Z][A-Z0-9_]{0,50}_API_KEY$/;
export function validApiKeyEnv(name: string | null): name is string {
    return !!name && API_KEY_ENV.test(name) && !name.startsWith('AGORA_');
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

export function boxLabels(instance: string, boxId: string): Record<string, string> {
    return { [LABEL_INSTANCE]: instance, [LABEL_BOX]: boxId.trim() };
}

export function clampLimits(l: BoxLimits): BoxLimits {
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    return {
        cpus: clamp(Number(l.cpus) || 2, 0.25, LIMIT_CEILINGS.cpus),
        memoryMb: Math.round(clamp(Number(l.memoryMb) || 4096, 512, LIMIT_CEILINGS.memoryMb)),
        pids: Math.round(clamp(Number(l.pids) || 1024, 64, LIMIT_CEILINGS.pids)),
    };
}

export function containerEnv(input: BoxSpecInput): string[] {
    const p = input.profile;
    const repos = p.repos.filter(r => REPO.test(r) && !r.split('/')[1].match(/^\.\.?$/));
    const profile = { name: p.name, adapter: p.adapter, auth: p.auth, apiKeyEnv: p.apiKeyEnv, workdirAlias: 'work', repos };
    const proxy = `http://${EDGE_HOSTNAME}:${EDGE_PROXY_PORT}`;
    const env = [
        `HOME=${BOX_HOME}`,
        `AGORA_BOX_ID=${input.boxId.trim()}`,
        `AGORA_BOX_GENERATION=${input.generation}`,
        `AGORA_INSTANCE_URL=http://${EDGE_HOSTNAME}:${EDGE_AGORA_PORT}`,
        `AGORA_HOST_TOKEN=${input.hostToken}`,
        `AGORA_BOT_ID=${input.botId.trim()}`,
        `AGORA_BOT_TOKEN=${input.botToken}`,
        `AGORA_BOX_PROFILE=${JSON.stringify(profile)}`,
        `HTTPS_PROXY=${proxy}`,
        `HTTP_PROXY=${proxy}`,
        `NO_PROXY=${EDGE_HOSTNAME}`,
        // curl and some others read only the lowercase names
        `https_proxy=${proxy}`,
        `http_proxy=${proxy}`,
        `no_proxy=${EDGE_HOSTNAME}`,
    ];
    if (p.auth === 'api_key' && input.apiKey) {
        if (!validApiKeyEnv(p.apiKeyEnv)) throw new Error('Invalid API key variable name');
        env.push(`${p.apiKeyEnv}=${input.apiKey}`);
    }
    return env;
}

export function networkSpec(instance: string, boxId: string, subnet: string) {
    return {
        Name: boxNetworkName(instance, boxId),
        Driver: 'bridge',
        Internal: true,
        Attachable: false,
        EnableIPv6: false,
        CheckDuplicate: true,
        IPAM: { Driver: 'default', Config: [{ Subnet: subnet, Gateway: gatewayAddress(subnet) }] },
        Labels: boxLabels(instance, boxId),
    };
}

export function volumeSpec(instance: string, boxId: string) {
    return { Name: boxVolumeName(instance, boxId), Driver: 'local', Labels: boxLabels(instance, boxId) };
}

export function containerSpec(input: BoxSpecInput): ContainerCreateOptions {
    const limits = clampLimits(input.limits);
    const network = boxNetworkName(input.instance, input.boxId);
    const memoryBytes = limits.memoryMb * 1024 * 1024;
    return {
        name: boxContainerName(input.instance, input.boxId),
        Image: input.image,
        Env: containerEnv(input),
        User: BOX_USER,
        WorkingDir: BOX_HOME,
        AttachStdin: false,
        AttachStdout: false,
        AttachStderr: false,
        OpenStdin: false,
        Tty: false,
        StopTimeout: STOP_TIMEOUT_SECONDS,
        Labels: {
            ...boxLabels(input.instance, input.boxId),
            [LABEL_BOX_VERSION]: String(input.imageVersion),
            [LABEL_BOX_GENERATION]: String(input.generation),
        },
        HostConfig: {
            Runtime: input.runtime,
            NetworkMode: network,
            Privileged: false,
            ReadonlyRootfs: true,
            Tmpfs: { ...TMPFS },
            Binds: [],
            Mounts: [{ Type: 'volume', Source: boxVolumeName(input.instance, input.boxId), Target: BOX_HOME, ReadOnly: false }],
            CapDrop: ['ALL'],
            CapAdd: [],
            SecurityOpt: ['no-new-privileges'],
            PidsLimit: limits.pids,
            Memory: memoryBytes,
            MemorySwap: memoryBytes,
            NanoCpus: Math.round(limits.cpus * 1e9),
            LogConfig: { Type: 'local', Config: { 'max-size': '10m', 'max-file': '3' } },
            AutoRemove: false,
            RestartPolicy: { Name: 'unless-stopped' },
            PortBindings: {},
            PublishAllPorts: false,
            Devices: [],
            IpcMode: 'private',
            PidMode: '',
            UsernsMode: '',
            // gVisor has no Docker DNS (#7469): the edge is pinned by address
            ExtraHosts: [`${EDGE_HOSTNAME}:${edgeAddress(input.subnet)}`],
        },
        NetworkingConfig: {
            EndpointsConfig: { [network]: { IPAMConfig: { IPv4Address: boxAddress(input.subnet) } } },
        },
    };
}

// ─── The check before every start (§7.2) ───

/** What a box container must be, from the row; tokens aren't needed to check it. */
export interface ExpectedBox {
    instance: string;
    boxId: string;
    generation: number;
    image: string;
    imageVersion: number;
    runtime: 'runsc' | 'runc';
    subnet: string;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const empty = (v: unknown) => v === undefined || v === null || (Array.isArray(v) && v.length === 0)
    || (typeof v === 'object' && v !== null && Object.keys(v).length === 0) || v === '';

/**
 * Every way an inspected container differs from what boxd would have created for the row.
 * Empty means it may start. Limits and generation are not here: a difference there is a
 * reason to rebuild, not a sign of tampering.
 */
export function containerDrift(info: any, e: ExpectedBox): string[] {
    const out: string[] = [];
    const cfg = info?.Config ?? {};
    const hc = info?.HostConfig ?? {};
    const network = boxNetworkName(e.instance, e.boxId);
    const volume = boxVolumeName(e.instance, e.boxId);
    const name = String(info?.Name ?? '').replace(/^\//, '');
    if (name !== boxContainerName(e.instance, e.boxId)) out.push('name');
    if (cfg.Image !== e.image) out.push('image');
    if (cfg.User !== BOX_USER) out.push('user');
    if ((hc.Runtime || 'runc') !== e.runtime) out.push('runtime');
    if (hc.Privileged !== false) out.push('privileged');
    if (hc.ReadonlyRootfs !== true) out.push('read-only');
    if (!same(hc.CapDrop, ['ALL'])) out.push('cap-drop');
    if (!empty(hc.CapAdd)) out.push('cap-add');
    if (!same(hc.SecurityOpt, ['no-new-privileges'])) out.push('security-opt');
    if (!same(sortKeys(hc.Tmpfs ?? {}), sortKeys(TMPFS))) out.push('tmpfs');
    if (!empty(hc.Binds)) out.push('binds');
    if (!empty(hc.VolumesFrom)) out.push('volumes-from');
    if (!empty(hc.Devices) || !empty(hc.DeviceRequests) || !empty(hc.DeviceCgroupRules)) out.push('devices');
    if (!empty(hc.PortBindings) || hc.PublishAllPorts) out.push('ports');
    if (!empty(hc.PidMode) || !empty(hc.UsernsMode) || !empty(hc.UTSMode) || hc.IpcMode !== 'private') out.push('namespaces');
    if (!empty(hc.Links)) out.push('links');
    if (hc.NetworkMode !== network) out.push('network-mode');
    if (!same(hc.ExtraHosts ?? [], [`${EDGE_HOSTNAME}:${edgeAddress(e.subnet)}`])) out.push('extra-hosts');
    const mounts = (info?.Mounts ?? []) as any[];
    if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== volume || mounts[0].Destination !== BOX_HOME) out.push('mounts');
    const nets = info?.NetworkSettings?.Networks ?? {};
    const netNames = Object.keys(nets);
    if (netNames.length !== 1 || netNames[0] !== network) out.push('networks');
    else if (nets[network]?.IPAMConfig?.IPv4Address !== boxAddress(e.subnet)) out.push('address');
    const labels = cfg.Labels ?? {};
    if (labels[LABEL_INSTANCE] !== e.instance || labels[LABEL_BOX] !== e.boxId.trim()
        || labels[LABEL_BOX_VERSION] !== String(e.imageVersion)) out.push('labels');
    return out;
}

function sortKeys(o: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

/** True when the container's limits aren't the row's (clamped): the owner changed them. */
export function limitsDiffer(info: any, limits: BoxLimits): boolean {
    const l = clampLimits(limits);
    const hc = info?.HostConfig ?? {};
    return hc.NanoCpus !== Math.round(l.cpus * 1e9) || hc.Memory !== l.memoryMb * 1024 * 1024 || hc.PidsLimit !== l.pids;
}

/** The generation and image version the container was created with (its labels). */
export function containerGeneration(info: any): number | null {
    const v = info?.Config?.Labels?.[LABEL_BOX_GENERATION];
    return v !== undefined && /^\d+$/.test(v) ? Number(v) : null;
}

/** A network boxd made for this box: internal, its labels, the row's subnet. */
export function networkDrift(info: any, instance: string, boxId: string, subnet: string): string[] {
    const out: string[] = [];
    if (info?.Internal !== true) out.push('not internal');
    const labels = info?.Labels ?? {};
    if (labels[LABEL_INSTANCE] !== instance || labels[LABEL_BOX] !== boxId.trim()) out.push('labels');
    const subnets = ((info?.IPAM?.Config ?? []) as any[]).map(c => c.Subnet).filter(Boolean);
    if (subnets.length !== 1 || subnets[0] !== subnet) out.push('subnet');
    return out;
}
