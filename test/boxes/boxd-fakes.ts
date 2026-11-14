import { BoxGoneError, type BoxTokens } from '../../src/lib/boxes/tokens';
import type { BoxNoticeKind } from '../../src/boxes/boxd/notices';
import type { BoxRecord, BoxRow, BoxStore, PendingAction } from '../../src/boxes/boxd/store';

/**
 * An in-memory BoxStore for the reconcile tests (test/unit/boxd-reconcile.unit.test.ts with a
 * fake Docker, test/boxes/boxd.box.test.ts with the real one). Token minting against the DB is
 * tested in test/integration/box-tokens.integration.test.ts.
 */

let seq = 0;
/** A valid ULID-shaped box ID (Crockford base32, 26 chars). */
export function fakeBoxId(): string {
    seq++;
    return `01JBX${String(seq).padStart(21, '0')}`;
}

export function boxRow(over: Partial<BoxRow> = {}): BoxRow {
    const id = over.id ?? fakeBoxId();
    return {
        id, name: `box${id.slice(-4)}`, adapter: 'claude', auth: 'subscription',
        profileId: `P${id.slice(1)}`, hostId: `H${id.slice(1)}`, homeChannelId: 'C'.repeat(26),
        generation: 0, desiredState: 'running', state: 'creating', pendingAction: null, actionRequestedAt: null,
        imageVersion: null, containerId: null, subnet: null, cpus: 2, memoryMb: 1024, pids: 256,
        failures: 0, lastError: null, volumePurgeAfter: null,
        ...over,
    };
}

export class MemoryStore implements BoxStore {
    rows: BoxRow[] = [];
    minted: BoxTokens[] = [];
    notices: { boxId: string; kind: BoxNoticeKind; content: string }[] = [];
    activeRuns = new Set<string>();
    repos: Record<string, string[]> = {};

    add(over: Partial<BoxRow> = {}): BoxRow {
        const row = boxRow(over);
        this.rows.push(row);
        return row;
    }
    get(id: string): BoxRow { return this.rows.find(r => r.id === id)!; }
    /** As the API does: an owner action with its request time. */
    request(id: string, action: PendingAction) {
        Object.assign(this.get(id), { pendingAction: action, actionRequestedAt: new Date() });
    }

    async listBoxes() { return this.rows.map(r => ({ ...r })); }
    async setSubnet(boxId: string, subnet: string) {
        if (this.rows.some(r => r.id !== boxId && r.subnet === subnet && r.desiredState !== 'deleted')) return false;
        this.get(boxId).subnet = subnet;
        return true;
    }
    async record(boxId: string, f: BoxRecord) {
        const r = this.get(boxId);
        if (f.state !== undefined) r.state = f.state;
        if (f.containerId !== undefined) r.containerId = f.containerId;
        if (f.imageVersion !== undefined) r.imageVersion = f.imageVersion;
        if (f.subnet !== undefined) r.subnet = f.subnet;
        if (f.lastError !== undefined) r.lastError = f.lastError;
        if (f.failures !== undefined) r.failures = f.failures;
    }
    async clearAction(boxId: string, action: PendingAction, requestedAt: Date | null) {
        const r = this.get(boxId);
        if (r.pendingAction === action && r.actionRequestedAt?.getTime() === requestedAt?.getTime()) {
            r.pendingAction = null; r.actionRequestedAt = null;
        }
    }
    async mintTokens(boxId: string): Promise<BoxTokens> {
        const r = this.get(boxId);
        if (!r || r.desiredState === 'deleted') throw new BoxGoneError(boxId);
        r.generation += 1;
        const t = {
            generation: r.generation, hostId: r.hostId, hostToken: `ah_${r.hostId}.secret${r.generation}`, relayToken: `ar_${r.hostId}.relay${r.generation}`,
            botId: `B${boxId.slice(1)}`, botToken: `bot_${boxId}.secret${r.generation}`,
        };
        this.minted.push(t);
        return t;
    }
    async boxInputs(box: BoxRow) { return { repos: this.repos[box.id] ?? [], apiKeyEnv: null, apiKey: null }; }
    async hasActiveRun(box: BoxRow) { return this.activeRuns.has(box.id); }
    async notice(box: BoxRow, kind: BoxNoticeKind, content: string) { this.notices.push({ boxId: box.id, kind, content }); }
}

export const quietLog = { info: () => {}, warn: () => {}, error: () => {} };
