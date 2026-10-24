import { describe, expect, it } from 'vitest';
import { Virtualizer } from '@tanstack/virtual-core';
import { computeNoticeRuns, isHiddenInRun, resizeRunRows } from './systemNotices';

/**
 * #118 review: collapsing a run must not leave the expanded rows' measured heights in the
 * REAL virtualizer's cache, or the list keeps blank scroll space below the drawer row.
 */
function notices(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `m${String(i).padStart(3, '0')}`, systemEvent: 'agent_session', content: `notice ${i}` }));
}

function makeVirtualizer(count: number, estimate: (i: number) => number) {
  const v = new Virtualizer<HTMLDivElement, HTMLDivElement>({
    count,
    getScrollElement: () => null,
    estimateSize: estimate,
    scrollToFn: () => {},
    observeElementRect: () => {},
    observeElementOffset: () => {},
  });
  v._willUpdate();
  // private in @tanstack/virtual-core; the test needs the measurement cache populated
  (v as unknown as { getMeasurements(): unknown }).getMeasurements();
  return v;
}

describe('notice run heights in the real virtualizer', () => {
  it('collapsing 100 measured notices shrinks the list to the drawer row', () => {
    const messages = notices(100);
    const runs = computeNoticeRuns(messages);
    let expanded = true;
    const estimate = (i: number) => {
      const run = runs[i]!;
      if (isHiddenInRun(run, expanded)) return 0;
      if (run.position === 0) return expanded ? 76 : 36;
      return 36;
    };
    const v = makeVirtualizer(messages.length, estimate);
    // Every row measured while the run was open (header + notice on the first row)
    for (let i = 0; i < messages.length; i++) v.resizeItem(i, i === 0 ? 72 : 37);
    expect(v.getTotalSize()).toBe(72 + 99 * 37);

    expanded = false;
    // Without invalidation the cached measurements win: the bug Codex reproduced
    expect(v.getTotalSize()).toBe(72 + 99 * 37);
    resizeRunRows(v, runs, new Set([runs[0]!.key]), estimate);
    expect(v.getTotalSize()).toBe(36);

    // And back open: the estimates come back for the offscreen rows
    expanded = true;
    resizeRunRows(v, runs, new Set([runs[0]!.key]), estimate);
    expect(v.getTotalSize()).toBe(76 + 99 * 36);
  });

  it('leaves rows of other runs alone', () => {
    const messages = [...notices(3), { id: 'x', systemEvent: null, content: 'hi' }, ...notices(3).map(m => ({ ...m, id: `n${m.id}` }))];
    const runs = computeNoticeRuns(messages);
    const v = makeVirtualizer(messages.length, () => 10);
    for (let i = 0; i < messages.length; i++) v.resizeItem(i, 50);
    resizeRunRows(v, runs, new Set([runs[0]!.key]), () => 0);
    expect(v.getTotalSize()).toBe(4 * 50);
  });
});
