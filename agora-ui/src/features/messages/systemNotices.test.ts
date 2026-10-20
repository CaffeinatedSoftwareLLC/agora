import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXPANDED_RUNS_CAP, computeNoticeRuns, expandedRunsKey, isHiddenInRun, isPlainNotice,
  loadExpandedRuns, saveExpandedRuns, toggleRunKey, truncateNotice,
} from './systemNotices';

const m = (id: string, systemEvent?: string) => ({ id, systemEvent });

describe('isPlainNotice', () => {
  it('accepts session notices and generic system events', () => {
    expect(isPlainNotice(m('a', 'agent_session'))).toBe(true);
    expect(isPlainNotice(m('a', 'loop_guard'))).toBe(true);
  });
  it('rejects normal messages and interactive cards', () => {
    expect(isPlainNotice(m('a'))).toBe(false);
    for (const ev of ['runtime_search', 'runtime_report', 'runtime_result', 'agent_tool_approval', 'agent_run_approval',
      'agent_permission_relay', 'task_card', 'subtask', 'provider_terms']) {
      expect(isPlainNotice(m('a', ev))).toBe(false);
    }
  });
});

describe('computeNoticeRuns', () => {
  it('groups 2+ consecutive plain notices keyed by the first id', () => {
    const runs = computeNoticeRuns([m('1'), m('2', 'agent_session'), m('3', 'loop_guard'), m('4', 'agent_session'), m('5')]);
    expect(runs[0]).toBeNull();
    expect(runs[1]).toEqual({ key: '2', size: 3, position: 0 });
    expect(runs[2]).toEqual({ key: '2', size: 3, position: 1 });
    expect(runs[3]).toEqual({ key: '2', size: 3, position: 2 });
    expect(runs[4]).toBeNull();
  });
  it('leaves a lone notice alone and lets cards break runs', () => {
    const runs = computeNoticeRuns([m('1', 'agent_session'), m('2', 'task_card'), m('3', 'agent_session'), m('4', 'agent_session')]);
    expect(runs[0]).toBeNull();
    expect(runs[1]).toBeNull();
    expect(runs[2]?.key).toBe('3');
    expect(runs[3]?.size).toBe(2);
  });
  it('handles empty input', () => {
    expect(computeNoticeRuns([])).toEqual([]);
  });
});

describe('isHiddenInRun', () => {
  it('hides only non-first members of a collapsed run', () => {
    expect(isHiddenInRun(null, false)).toBe(false);
    expect(isHiddenInRun({ key: 'a', size: 2, position: 0 }, false)).toBe(false);
    expect(isHiddenInRun({ key: 'a', size: 2, position: 1 }, false)).toBe(true);
    expect(isHiddenInRun({ key: 'a', size: 2, position: 1 }, true)).toBe(false);
  });
});

describe('truncateNotice', () => {
  it('returns null for short text', () => {
    expect(truncateNotice('Session started')).toBeNull();
    expect(truncateNotice('1\n2\n3\n4\n5\n6')).toBeNull();
    expect(truncateNotice(undefined)).toBeNull();
  });
  it('cuts to 6 lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `file${i}.ts`).join('\n');
    const short = truncateNotice(text)!;
    expect(short.split('\n')).toHaveLength(6);
    expect(short.endsWith('file5.ts…')).toBe(true);
  });
  it('cuts a very long single line to 600 chars', () => {
    const short = truncateNotice('x'.repeat(2000))!;
    expect(short).toHaveLength(601);
  });
});

describe('expanded run storage', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function memoryStorage() {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, data };
  }

  it('round-trips per user', () => {
    const store = memoryStorage();
    vi.stubGlobal('localStorage', store);
    saveExpandedRuns('u1', ['a', 'b']);
    expect(loadExpandedRuns('u1')).toEqual(['a', 'b']);
    expect(loadExpandedRuns('u2')).toEqual([]);
    expect(store.data.has(expandedRunsKey('u1'))).toBe(true);
  });
  it('caps the stored list, keeping the newest', () => {
    vi.stubGlobal('localStorage', memoryStorage());
    const keys = Array.from({ length: EXPANDED_RUNS_CAP + 50 }, (_, i) => `k${i}`);
    saveExpandedRuns('u1', keys);
    const loaded = loadExpandedRuns('u1');
    expect(loaded).toHaveLength(EXPANDED_RUNS_CAP);
    expect(loaded[loaded.length - 1]).toBe(`k${EXPANDED_RUNS_CAP + 49}`);
  });
  it('survives storage that throws or holds junk', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(loadExpandedRuns('u1')).toEqual([]);
    expect(() => saveExpandedRuns('u1', ['a'])).not.toThrow();
    vi.stubGlobal('localStorage', { getItem: () => '{not json', setItem: vi.fn() });
    expect(loadExpandedRuns('u1')).toEqual([]);
    vi.stubGlobal('localStorage', { getItem: () => '[1,"a",null]', setItem: vi.fn() });
    expect(loadExpandedRuns('u1')).toEqual(['a']);
  });
  it('does nothing without a user', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem });
    saveExpandedRuns(undefined, ['a']);
    expect(loadExpandedRuns(undefined)).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
  });
  it('toggles keys', () => {
    expect(toggleRunKey(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleRunKey(['a', 'b'], 'a')).toEqual(['b']);
  });
});
