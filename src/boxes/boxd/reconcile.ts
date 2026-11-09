import { LABEL_BOX, LABEL_INSTANCE, boxContainerName, boxNetworkName, boxVolumeName } from '../../lib/boxes/contract';
import { BoxGoneError } from '../../lib/boxes/tokens';
import { notFound, statusOf, type BoxDockerApi, type NetworkInfo } from './docker';
import {
    STOP_TIMEOUT_SECONDS, boxLabels, containerDrift, containerGeneration, containerSpec, limitsDiffer, networkDrift, networkSpec, volumeSpec,
    validApiKeyEnv,
} from './spec';
import { edgeAddress, isOverlapError, overlaps, parseCidr, pickSubnet, type Cidr } from './subnets';
import type { BoxRow, BoxStore, PendingAction } from './store';

/**
 * The boxd reconcile loop (docs/agent-boxes.md §7.1, §9). Each pass, for every box row:
 * network → the edge attached at .2 → home volume → container, then the row's owner action
 * (restart, rebuild, reset) and desired state (running, stopped, deleted). Before every start
 * the container is inspected and refused if it isn't what boxd would create (§7.2).
 * After the boxes: at most one upgrade (image_version below the current box/VERSION, or a
 * container on an older build of the current image: the stack rebuilt agora/box:<VERSION> with
 * new agora-host or agora-mcp code, which bumps no VERSION), then this instance's labelled
 * leftovers that no row claims are removed.
 *
 * boxd reads only DB rows and Docker replies; nothing from a box reaches it.
 */

export const BACKOFF_START_MS = 15_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
export const FAIL_WINDOW_MS = 10 * 60_000;
export const FAIL_LIMIT = 5;
export const UPGRADE_WAIT_MS = 15 * 60_000;
const SUBNET_ATTEMPTS = 8;
/** Any box image the stack built; a container on an older version (waiting to upgrade) runs one of these. */
const BOX_IMAGE = /^agora\/box:[0-9A-Za-z._-]+$/;

export interface ReconcileConfig {
    instance: string;
    /** The image new and rebuilt boxes get (AGORA_BOX_IMAGE) and its box/VERSION. */
    image: string;
    imageVersion: number;
    runtime: 'runsc' | 'runc';
    /** The edge container's name (AGORA_EDGE_CONTAINER). */
    edgeContainer: string;
    subnets: Cidr[];
}

export interface Log {
    info: (...a: unknown[]) => void;
    warn: (...a: unknown[]) => void;
    error: (...a: unknown[]) => void;
}

/** Something on the engine isn't what boxd made: refuse, alert, wait for the owner. */
export class DriftError extends Error {}

interface Track {
    failures: number[];
    delayMs: number;
    nextAt: number;
    notified: boolean;
    restartCount?: number;
    upgradeWaitSince?: number;
    /** Its container runs an older build of the current image (seen at the last ensure). */
    staleBuild?: boolean;
}

interface PassContext {
    boxes: BoxRow[];
    networks: NetworkInfo[];
    containers: Set<string>;
    volumes: Set<string>;
    /** The image ID the configured tag names now; null when unknown. */
    imageId: string | null;
}

type Outcome = 'ok' | 'held';

const errText = (err: unknown) => {
    const e = err as any;
    return String(e?.json?.message ?? e?.reason ?? e?.message ?? err).replace(/\s+/g, ' ').slice(0, 300);
};

export class Reconciler {
    private track = new Map<string, Track>();
    private stopping = false;

    constructor(private d: {
        docker: BoxDockerApi;
        store: BoxStore;
        config: ReconcileConfig;
        log: Log;
        now?: () => number;
    }) {}

    private now() { return this.d.now ? this.d.now() : Date.now(); }
    private get cfg() { return this.d.config; }
    private names(boxId: string) {
        return {
            container: boxContainerName(this.cfg.instance, boxId),
            network: boxNetworkName(this.cfg.instance, boxId),
            volume: boxVolumeName(this.cfg.instance, boxId),
        };
    }
    private trackOf(boxId: string): Track {
        let t = this.track.get(boxId);
        if (!t) { t = { failures: [], delayMs: 0, nextAt: 0, notified: false }; this.track.set(boxId, t); }
        return t;
    }

    /** Stop after the box being worked on (SIGTERM; install/backup.sh waits for this). */
    stop() { this.stopping = true; }

    async pass(): Promise<void> {
        const boxes = await this.d.store.listBoxes();
        const label = { label: [`${LABEL_INSTANCE}=${this.cfg.instance}`] };
        const ctx: PassContext = {
            boxes,
            networks: await this.d.docker.listNetworks(),
            containers: new Set((await this.d.docker.listContainers(label)).map(c => (c.Names?.[0] ?? '').replace(/^\//, ''))),
            volumes: new Set((await this.d.docker.listVolumes(label)).map(v => v.Name)),
            imageId: (await this.d.docker.imageInspect(this.cfg.image).catch(() => null))?.Id ?? null,
        };
        for (const box of boxes) {
            if (this.stopping) return;
            await this.reconcileOne(box, ctx);
        }
        if (this.stopping) return;
        await this.upgradeOne(ctx);
        if (this.stopping) return;
        await this.removeUnclaimed(boxes).catch(err => this.d.log.warn(`cleanup failed: ${errText(err)}`));
    }

    private async reconcileOne(box: BoxRow, ctx: PassContext) {
        const t = this.trackOf(box.id);
        // Backing off after errors (or held as failed); deletes and new owner actions don't wait.
        // The edge is re-attached even then: a recreated edge loses its box networks, and a box
        // that recovers on its own (Docker restarts it) must not wait out the backoff for a way out
        const waiting = box.desiredState !== 'deleted' && !box.pendingAction && (this.now() < t.nextAt || box.state === 'failed');
        if (waiting) {
            await this.reattachEdge(box).catch(err => this.d.log.warn(`box ${box.id}: edge re-attach failed: ${errText(err)}`));
            if (this.now() < t.nextAt) return;
        }
        try {
            const outcome = await this.reconcileBox(box, ctx, t);
            if (outcome === 'ok') await this.succeeded(box, t);
        } catch (err) {
            await this.failed(box, t, err);
        }
    }

    private async reconcileBox(box: BoxRow, ctx: PassContext, t: Track): Promise<Outcome> {
        if (box.desiredState === 'deleted') return this.teardown(box, ctx);

        const action = box.pendingAction;
        if (action) {
            // An owner action is what lifts a failed box
            t.failures = []; t.delayMs = 0; t.nextAt = 0; t.notified = false;
            const outcome = await this.ownerAction(box, ctx, action);
            await this.d.store.clearAction(box.id, action, box.actionRequestedAt);
            return outcome;
        }
        if (box.state === 'failed') return 'held';
        return this.ensure(box, ctx, t);
    }

    private async ownerAction(box: BoxRow, ctx: PassContext, action: PendingAction): Promise<Outcome> {
        if (action === 'rebuild' || action === 'reset') {
            if (action === 'reset') this.d.log.info(`box ${box.id}: reset (new home volume)`);
            return this.rebuild(box, ctx, action === 'reset');
        }
        // restart: the same container, restarted, after the same checks as a start
        const n = this.names(box.id);
        const info = await this.d.docker.inspectContainer(n.container);
        if (!info || box.desiredState !== 'running') return this.ensure(box, ctx, this.trackOf(box.id));
        const subnet = await this.ensureNetwork(box, ctx, false);
        await this.ensureEdge(box, subnet.subnet, subnet.info);
        await this.ensureVolume(box);
        if (subnet.recreated || this.needsRebuild(box, info)) return this.rebuild(box, ctx, false);
        const drift = await this.drift(box, info, subnet.subnet);
        if (drift.length) return this.refuse(box, info, drift);
        await this.d.docker.restartContainer(n.container, STOP_TIMEOUT_SECONDS);
        this.trackOf(box.id).restartCount = undefined;
        await this.d.store.record(box.id, { state: 'running', containerId: info.Id ?? null, seen: true });
        return 'ok';
    }

    /** Make the box what its row says, without replacing a good container. */
    private async ensure(box: BoxRow, ctx: PassContext, t: Track): Promise<Outcome> {
        const n = this.names(box.id);
        const net = await this.ensureNetwork(box, ctx, false);
        await this.ensureEdge(box, net.subnet, net.info);
        await this.ensureVolume(box);
        const info = await this.d.docker.inspectContainer(n.container);

        if (info && (net.recreated || this.needsRebuild(box, info))) {
            this.d.log.info(`box ${box.id}: recreating (${net.recreated ? 'network recreated' : 'generation, image or limits changed'})`);
            return this.rebuild(box, ctx, false);
        }
        if (!info) {
            if (box.desiredState === 'stopped') {
                if (box.state !== 'stopped') await this.d.store.record(box.id, { state: 'stopped' });
                return 'ok';
            }
            return this.create(box, net.subnet);
        }

        const drift = await this.drift(box, info, net.subnet);
        if (drift.length) return this.refuse(box, info, drift);
        // The same box/VERSION, built again with newer agora-host or agora-mcp code: the box
        // keeps the code it was created with until it is rebuilt (upgradeOne)
        t.staleBuild = !!ctx.imageId && !!info.Image && box.imageVersion === this.cfg.imageVersion && info.Image !== ctx.imageId;

        const running = !!info.State?.Running || !!info.State?.Restarting;
        if (box.desiredState === 'stopped') {
            if (running) await this.d.docker.stopContainer(n.container, STOP_TIMEOUT_SECONDS);
            if (box.state !== 'stopped') await this.d.store.record(box.id, { state: 'stopped', containerId: info.Id ?? null });
            return 'ok';
        }

        // A box process that keeps dying: Docker restarts it (unless-stopped); boxd counts
        const rc = Number(info.RestartCount ?? 0);
        if (t.restartCount !== undefined && rc > t.restartCount) {
            for (let i = 0; i < rc - t.restartCount; i++) t.failures.push(this.now());
        }
        t.restartCount = rc;
        if (this.recentFailures(t) >= FAIL_LIMIT) {
            await this.markFailed(box, `the box exited ${FAIL_LIMIT} or more times in 10 minutes`);
            return 'held';
        }

        if (!running) {
            await this.d.docker.startContainer(n.container);
            // A start resets Docker's restart count
            t.restartCount = 0;
        }
        await this.d.store.record(box.id, {
            seen: true,
            ...(box.state !== 'running' ? { state: 'running' as const } : {}),
            ...(box.containerId !== info.Id ? { containerId: info.Id ?? null } : {}),
        });
        return 'ok';
    }

    private needsRebuild(box: BoxRow, info: any): boolean {
        const labelVersion = Number(info?.Config?.Labels?.['org.agora.box.version']);
        return containerGeneration(info) !== box.generation
            || labelVersion !== box.imageVersion
            || limitsDiffer(info, box);
    }

    /** Remove the container (and with `wipe` the home volume), then create it again with new tokens. */
    private async rebuild(box: BoxRow, ctx: PassContext, wipe: boolean): Promise<Outcome> {
        const n = this.names(box.id);
        await this.removeContainer(n.container);
        if (wipe) {
            await this.d.docker.removeVolume(n.volume);
            ctx.volumes.delete(n.volume);
        }
        const net = await this.ensureNetwork(box, ctx, true);
        await this.ensureEdge(box, net.subnet, net.info);
        await this.ensureVolume(box);
        return this.create(box, net.subnet);
    }

    /** New tokens and generation, a container from the constants, started if it should run. */
    private async create(box: BoxRow, subnet: string): Promise<Outcome> {
        const n = this.names(box.id);
        const inputs = await this.d.store.boxInputs(box);
        if (box.auth === 'api_key' && !validApiKeyEnv(inputs.apiKeyEnv)) throw new Error('The box\'s API key variable name is invalid');
        // A leftover from a create that failed half-way
        await this.d.docker.removeContainer(n.container);
        const tokens = await this.d.store.mintTokens(box.id);
        box.generation = tokens.generation;
        const spec = containerSpec({
            instance: this.cfg.instance,
            boxId: box.id,
            generation: tokens.generation,
            image: this.cfg.image,
            imageVersion: this.cfg.imageVersion,
            runtime: this.cfg.runtime,
            subnet,
            limits: box,
            hostToken: tokens.hostToken,
            botId: tokens.botId,
            botToken: tokens.botToken,
            profile: {
                name: box.name, adapter: box.adapter, auth: box.auth,
                apiKeyEnv: box.auth === 'api_key' ? inputs.apiKeyEnv : null,
                workdirAlias: 'work', repos: inputs.repos,
            },
            apiKey: box.auth === 'api_key' ? inputs.apiKey : null,
        });
        const id = await this.d.docker.createContainer(spec);
        box.imageVersion = this.cfg.imageVersion;
        box.containerId = id;
        this.trackOf(box.id).restartCount = 0;
        this.d.log.info(`box ${box.id}: created container generation ${tokens.generation} image v${this.cfg.imageVersion}`);
        if (box.desiredState !== 'running') {
            await this.d.store.record(box.id, { state: 'stopped', containerId: id, imageVersion: this.cfg.imageVersion });
            return 'ok';
        }
        await this.d.store.record(box.id, { state: 'creating', containerId: id, imageVersion: this.cfg.imageVersion });
        const info = await this.d.docker.inspectContainer(n.container);
        const drift = info ? await this.drift(box, info, subnet) : ['missing after create'];
        if (drift.length) return this.refuse(box, info, drift);
        await this.d.docker.startContainer(n.container);
        await this.d.store.record(box.id, { state: 'running', seen: true });
        return 'ok';
    }

    // ─── Network, edge, volume ───

    private takenSubnets(ctx: PassContext, box: BoxRow, ownNetwork: string): string[] {
        const engine = ctx.networks.filter(nw => nw.Name !== ownNetwork)
            .flatMap(nw => (nw.IPAM?.Config ?? []).map(c => c.Subnet).filter((s): s is string => !!s));
        const db = ctx.boxes.filter(b => b.id !== box.id && b.subnet && b.desiredState !== 'deleted').map(b => b.subnet!);
        return [...engine, ...db];
    }

    /**
     * The box's own internal /28 network. A network that exists but isn't what boxd made is
     * drift; with `replace` (a rebuild) it's removed and made again instead.
     */
    private async ensureNetwork(box: BoxRow, ctx: PassContext, replace: boolean): Promise<{ subnet: string; recreated: boolean; info: NetworkInfo | null }> {
        const n = this.names(box.id);
        const existing = await this.d.docker.inspectNetwork(n.network);
        if (existing) {
            const subnet = box.subnet ?? existing.IPAM?.Config?.[0]?.Subnet ?? null;
            const drift = subnet ? networkDrift(existing, this.cfg.instance, box.id, subnet) : ['no subnet'];
            if (!drift.length && subnet) {
                if (!box.subnet) {
                    // The row lost its subnet (a restore); adopt the network's if no other box holds it
                    if (!await this.d.store.setSubnet(box.id, subnet)) throw new DriftError(`network ${n.network} uses a subnet another box holds`);
                    box.subnet = subnet;
                }
                return { subnet, recreated: false, info: existing };
            }
            if (!replace) throw new DriftError(`network ${n.network} differs from its spec (${drift.join(', ')})`);
            await this.removeNetwork(n.network, existing);
            ctx.networks = ctx.networks.filter(nw => nw.Name !== n.network);
        }

        const taken = this.takenSubnets(ctx, box, n.network);
        let subnet = box.subnet;
        // A subnet the row holds but something else on the engine now overlaps: pick another
        if (subnet) {
            const own = parseCidr(subnet);
            if (!own || taken.some(s => { const c = parseCidr(s); return !!c && overlaps(own, c); })) subnet = null;
        }
        for (let attempt = 0; attempt < SUBNET_ATTEMPTS; attempt++) {
            if (!subnet) {
                subnet = pickSubnet(this.cfg.subnets, taken);
                if (!subnet) throw new Error('No free /28 left in AGORA_BOX_SUBNETS');
                if (!await this.d.store.setSubnet(box.id, subnet)) { taken.push(subnet); subnet = null; continue; }
                box.subnet = subnet;
            }
            try {
                await this.d.docker.createNetwork(networkSpec(this.cfg.instance, box.id, subnet));
            } catch (err) {
                if (isOverlapError(err)) { taken.push(subnet); subnet = null; continue; }
                throw err;
            }
            ctx.networks.push({ Name: n.network, IPAM: { Config: [{ Subnet: subnet }] } });
            this.d.log.info(`box ${box.id}: network ${n.network} ${subnet}`);
            return { subnet, recreated: true, info: null };
        }
        throw new Error('Could not find a free /28 for the box network (every candidate overlapped)');
    }

    /**
     * The edge on the box network at .2. A recreated edge loses networks attached at run time,
     * so this re-attaches it; the pinned address keeps the box's /etc/hosts right (§9.3).
     * Anything else on the network is disconnected.
     */
    /** Put the edge back on an existing, matching box network; creates nothing else. */
    private async reattachEdge(box: BoxRow) {
        if (!box.subnet) return;
        const info = await this.d.docker.inspectNetwork(this.names(box.id).network);
        if (!info || networkDrift(info, this.cfg.instance, box.id, box.subnet).length) return;
        await this.ensureEdge(box, box.subnet, info);
    }

    private async ensureEdge(box: BoxRow, subnet: string, known: NetworkInfo | null) {
        const n = this.names(box.id);
        const want = edgeAddress(subnet);
        const info = known ?? await this.d.docker.inspectNetwork(n.network);
        let edgeOk = false;
        let edgeWrong = false;
        for (const ep of Object.values(info?.Containers ?? {})) {
            const name = ep.Name ?? '';
            if (name === this.cfg.edgeContainer) {
                if ((ep.IPv4Address ?? '').split('/')[0] === want) edgeOk = true; else edgeWrong = true;
            } else if (name !== n.container) {
                this.d.log.warn(`box ${box.id}: disconnecting ${name} from ${n.network} (only the edge and the box belong there)`);
                await this.d.docker.disconnectNetwork(n.network, name);
            }
        }
        if (edgeOk) return;
        if (edgeWrong) await this.d.docker.disconnectNetwork(n.network, this.cfg.edgeContainer);
        try {
            await this.d.docker.connectNetwork(n.network, this.cfg.edgeContainer, want);
            this.d.log.info(`box ${box.id}: edge attached at ${want}`);
        } catch (err) {
            // A stopped edge keeps its endpoint but isn't listed: already attached
            if (/already exists/i.test(errText(err))) return;
            if (notFound(err)) {
                this.d.log.warn(`box ${box.id}: edge container ${this.cfg.edgeContainer} not found; the box has no way out until it's back`);
                return;
            }
            throw err;
        }
    }

    private async ensureVolume(box: BoxRow) {
        const n = this.names(box.id);
        const vol = await this.d.docker.inspectVolume(n.volume);
        if (!vol) {
            await this.d.docker.createVolume(volumeSpec(this.cfg.instance, box.id));
            return;
        }
        const want = boxLabels(this.cfg.instance, box.id);
        if (vol.Labels?.[LABEL_INSTANCE] !== want[LABEL_INSTANCE] || vol.Labels?.[LABEL_BOX] !== want[LABEL_BOX]) {
            throw new DriftError(`volume ${n.volume} was not made by boxd (labels)`);
        }
        // A local volume with options (type=none,o=bind,device=/host/path) is a bind mount by
        // another name: labels can be copied, so the driver and its options are checked too
        if (vol.Driver !== 'local' || Object.keys(vol.Options ?? {}).length > 0) {
            throw new DriftError(`volume ${n.volume} is not a plain local volume (driver ${vol.Driver ?? '?'}${Object.keys(vol.Options ?? {}).length ? ', with options' : ''})`);
        }
    }

    private async drift(box: BoxRow, info: any, subnet: string): Promise<string[]> {
        const n = this.names(box.id);
        const out = containerDrift(info, {
            instance: this.cfg.instance, boxId: box.id, generation: box.generation,
            image: box.imageVersion === this.cfg.imageVersion ? this.cfg.image : '', imageVersion: box.imageVersion ?? -1,
            runtime: this.cfg.runtime, subnet,
        });
        // An older box image, waiting for its upgrade, is still one of ours
        const imageIdx = out.indexOf('image');
        if (imageIdx !== -1 && box.imageVersion !== this.cfg.imageVersion && BOX_IMAGE.test(String(info?.Config?.Image ?? ''))) out.splice(imageIdx, 1);
        // Its home volume is mounted by no other container
        const users = await this.d.docker.listContainers({ volume: [n.volume] });
        if (users.some(c => (c.Names?.[0] ?? '').replace(/^\//, '') !== n.container)) out.push('volume shared');
        return out;
    }

    /** Not what boxd made: don't run it, say so once, wait for a rebuild. */
    private async refuse(box: BoxRow, info: any, drift: string[]): Promise<Outcome> {
        const n = this.names(box.id);
        if (info?.State?.Running || info?.State?.Restarting) await this.d.docker.stopContainer(n.container, 10);
        const what = drift.join(', ');
        this.d.log.error(`box ${box.id}: refused to start, container differs from its spec: ${what}`);
        await this.d.store.record(box.id, { state: 'failed', lastError: `Refused to start: the container differs from what boxd created (${what}). Rebuild the box.` });
        if (box.state !== 'failed') {
            await this.d.store.notice(box, 'drift', `Box **${box.name}** was not started: its container differs from what boxd created (${what}). Rebuild it in Settings → Agents.`);
        }
        box.state = 'failed';
        return 'held';
    }

    // ─── Delete, failures ───

    private async teardown(box: BoxRow, ctx: PassContext): Promise<Outcome> {
        const n = this.names(box.id);
        const purgeDue = !!box.volumePurgeAfter && box.volumePurgeAfter.getTime() <= this.now();
        const nothingLeft = box.state === 'deleted' && !box.subnet && !ctx.containers.has(n.container)
            && !(purgeDue && ctx.volumes.has(n.volume));
        if (nothingLeft && !box.pendingAction) return 'ok';

        await this.removeContainer(n.container);
        const net = await this.d.docker.inspectNetwork(n.network);
        if (net) await this.removeNetwork(n.network, net);
        if (purgeDue) {
            await this.d.docker.removeVolume(n.volume);
            this.d.log.info(`box ${box.id}: home volume purged`);
        }
        await this.d.store.record(box.id, {
            ...(box.state !== 'deleted' ? { state: 'deleted' as const } : {}),
            // Free the subnet now: a restored box may get another one
            ...(box.subnet ? { subnet: null } : {}),
            ...(box.containerId ? { containerId: null } : {}),
        });
        if (box.pendingAction) await this.d.store.clearAction(box.id, box.pendingAction, box.actionRequestedAt);
        this.track.delete(box.id);
        return 'ok';
    }

    private recentFailures(t: Track): number {
        const since = this.now() - FAIL_WINDOW_MS;
        t.failures = t.failures.filter(ts => ts > since);
        return t.failures.length;
    }

    private async succeeded(box: BoxRow, t: Track) {
        if (t.delayMs) { t.delayMs = 0; t.nextAt = 0; t.notified = false; }
        if (box.lastError !== null && box.state !== 'failed') {
            await this.d.store.record(box.id, { lastError: null, failures: 0 });
            box.lastError = null;
        }
    }

    private async failed(box: BoxRow, t: Track, err: unknown) {
        if (err instanceof BoxGoneError) return;
        if (err instanceof DriftError) {
            const info = await this.d.docker.inspectContainer(this.names(box.id).container).catch(() => null);
            await this.refuse(box, info, [err.message]).catch(e => this.d.log.error(`box ${box.id}: ${errText(e)}`));
            return;
        }
        const msg = errText(err);
        t.failures.push(this.now());
        t.delayMs = t.delayMs ? Math.min(t.delayMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS;
        t.nextAt = this.now() + t.delayMs;
        const count = this.recentFailures(t);
        this.d.log.warn(`box ${box.id}: ${msg} (retry in ${Math.round(t.delayMs / 1000)} s)`);
        try {
            if (count >= FAIL_LIMIT) { await this.markFailed(box, msg); return; }
            await this.d.store.record(box.id, { lastError: msg, failures: count });
            if (!t.notified) {
                t.notified = true;
                await this.d.store.notice(box, 'error', `Box **${box.name}** could not be started: ${msg}. boxd keeps trying.`);
            }
        } catch (e) {
            this.d.log.error(`box ${box.id}: recording the failure failed: ${errText(e)}`);
        }
    }

    /** Five failed starts in ten minutes: stop it, record why, tell the owner (§9.3). */
    private async markFailed(box: BoxRow, msg: string) {
        await this.d.docker.stopContainer(this.names(box.id).container, 10).catch(() => { /* gone or unreachable */ });
        await this.d.store.record(box.id, { state: 'failed', lastError: msg, failures: FAIL_LIMIT });
        await this.d.store.notice(box, 'failed', `Box **${box.name}** failed to start ${FAIL_LIMIT} times in 10 minutes and was stopped: ${msg}. Rebuild or reset it in Settings → Agents.`);
        box.state = 'failed';
        const t = this.trackOf(box.id);
        t.failures = []; t.delayMs = 0; t.nextAt = 0; t.notified = false;
    }

    // ─── Upgrade, leftovers ───

    /**
     * One box per pass onto the current image, once its agent isn't mid-run (at most 15 minutes,
     * §9.1): a box on an older box/VERSION, or on an older build of the current one.
     */
    private async upgradeOne(ctx: PassContext) {
        const box = ctx.boxes.find(b => b.desiredState !== 'deleted' && b.state !== 'failed' && !b.pendingAction
            && b.imageVersion !== null && (b.imageVersion < this.cfg.imageVersion || !!this.track.get(b.id)?.staleBuild));
        if (!box) return;
        const t = this.trackOf(box.id);
        if (this.now() < t.nextAt) return;
        if (await this.d.store.hasActiveRun(box)) {
            t.upgradeWaitSince ??= this.now();
            if (this.now() - t.upgradeWaitSince < UPGRADE_WAIT_MS) return;
            this.d.log.info(`box ${box.id}: upgrading although a run is still active (waited 15 minutes)`);
        }
        const from = box.imageVersion;
        try {
            await this.rebuild(box, ctx, false);
            t.upgradeWaitSince = undefined;
            t.staleBuild = false;
            await this.d.store.notice(box, 'upgraded', from === this.cfg.imageVersion
                ? `Box **${box.name}** was updated to the current build of box image v${from} (newer agora-host and agora-mcp). Its home folder and logins are kept.`
                : `Box **${box.name}** was upgraded from box image v${from} to v${this.cfg.imageVersion}. Its home folder and logins are kept.`);
        } catch (err) {
            await this.failed(box, t, err);
        }
    }

    /** This instance's box containers, networks and volumes that no row claims. */
    private async removeUnclaimed(boxes: BoxRow[]) {
        const inst = this.cfg.instance;
        const claimed = new Set(boxes.map(b => b.id.toLowerCase()));
        const label = { label: [`${LABEL_INSTANCE}=${inst}`, LABEL_BOX] };
        const id = (re: RegExp, name: string) => re.exec(name)?.[1] ?? null;
        const cRe = new RegExp(`^${inst}-box-([0-9a-z]{26})$`);
        const nRe = new RegExp(`^${inst}_box_([0-9a-z]{26})$`);
        const vRe = new RegExp(`^${inst}-box-([0-9a-z]{26})-home$`);

        for (const c of await this.d.docker.listContainers(label)) {
            const name = (c.Names?.[0] ?? '').replace(/^\//, '');
            const boxId = id(cRe, name);
            if (boxId && !claimed.has(boxId)) {
                this.d.log.info(`removing unclaimed container ${name}`);
                await this.d.docker.removeContainer(name);
            }
        }
        for (const nw of await this.d.docker.listNetworks()) {
            const boxId = id(nRe, nw.Name);
            if (!boxId || claimed.has(boxId) || nw.Labels?.[LABEL_INSTANCE] !== inst) continue;
            this.d.log.info(`removing unclaimed network ${nw.Name}`);
            const info = await this.d.docker.inspectNetwork(nw.Name);
            if (info) await this.removeNetwork(nw.Name, info);
        }
        for (const v of await this.d.docker.listVolumes(label)) {
            const boxId = id(vRe, v.Name);
            if (boxId && !claimed.has(boxId)) {
                this.d.log.info(`removing unclaimed volume ${v.Name}`);
                await this.d.docker.removeVolume(v.Name);
            }
        }
    }

    private async removeContainer(name: string) {
        await this.d.docker.stopContainer(name, STOP_TIMEOUT_SECONDS).catch(err => {
            if (statusOf(err) !== 404) this.d.log.warn(`stopping ${name}: ${errText(err)}`);
        });
        await this.d.docker.removeContainer(name);
    }

    /** Disconnect whatever is attached (the edge), then remove the network. */
    private async removeNetwork(name: string, info: NetworkInfo) {
        for (const ep of Object.values(info.Containers ?? {})) {
            if (ep.Name) await this.d.docker.disconnectNetwork(name, ep.Name);
        }
        // A stopped edge isn't listed but still holds an endpoint
        await this.d.docker.disconnectNetwork(name, this.cfg.edgeContainer).catch(() => { /* not attached */ });
        await this.d.docker.removeNetwork(name);
    }
}
