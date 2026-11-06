import { describe, expect, it } from 'vitest';
import { Virtualizer } from '@tanstack/virtual-core';
import type { Message } from '../../stores/messageStore';
import { computeMessageRuns, isFoldableAgentMessage, isFoldableAgentUpdate, resizeChangedRunRows, type MessageRun } from './messageRuns';

// Every row offscreen (nothing measured); the run is open when open says so.
const offscreen = (estimate: (index: number) => number, open: (run: MessageRun) => boolean) =>
  ({ measure: () => undefined, estimate, wasExpanded: open, isExpanded: open });

const bot = (id: string, extra: Partial<Message> = {}): Message => ({
  id, content: id, authorId: 'claude', authorUsername: 'Claude', authorBot: true,
  channelId: 'channel', createdAt: '2026-10-22T00:00:00Z', ...extra,
});

describe('agent message runs', () => {
  it('keeps activity after the last human expanded, even across a visible bot attachment', () => {
    const messages = [bot('1'), bot('2'), bot('human', { authorBot: false }), bot('3'), bot('4'),
      bot('file', { attachments: [{ id: 'file' }] } as Partial<Message>)];
    const runs = computeMessageRuns(messages);
    expect(runs[0]?.defaultExpanded).toBe(false);
    expect(runs[3]?.defaultExpanded).toBe(true);
    expect(computeMessageRuns([...messages, bot('human2', { authorBot: false })])[3]?.defaultExpanded).toBe(false);
    const previous = messages.map((m, i) => ({ id: m.id, run: runs[i] }));
    const next = computeMessageRuns([...messages, bot('human2', { authorBot: false })]);
    const resized: number[] = [];
    resizeChangedRunRows({ resizeItem: index => resized.push(index) }, previous,
      messages.map((m, i) => ({ id: m.id, run: next[i] })), new Set(), offscreen(() => 48, run => run.defaultExpanded));
    expect(resized).toEqual([3, 4]);
  });
  it('folds two or more updates, counts all authors and keeps a lone update visible', () => {
    expect(computeMessageRuns([bot('1')])).toEqual([null]);
    expect(computeMessageRuns([bot('1'), bot('2')])[0]?.size).toBe(2);
    const runs = computeMessageRuns([bot('1'), bot('2', { authorId: 'codex', authorUsername: 'Codex' }), bot('3')]);
    expect(runs.map(run => run?.position)).toEqual([0, 1, 2]);
    expect(runs[0]).toMatchObject({ kind: 'agents', key: 'agents:1', size: 3, names: ['Claude', 'Codex'] });
  });

  it.each([
    { authorBot: false }, { authorBot: undefined }, { deletedAt: 'now' }, { pending: true },
    { failed: true }, { streaming: true }, { systemEvent: 'agent_run_approval' },
    { systemEvent: 'runtime_report' },
    { artifact: { id: 'artifact' } }, { attachments: [{ id: 'file' }] },
  ] as Partial<Message>[])('keeps a separator visible and breaks adjacent pairs: %j', separator => {
    const middle = bot('middle', separator);
    expect(isFoldableAgentMessage(middle)).toBe(false);
    const runs = computeMessageRuns([bot('1'), bot('2'), middle, bot('3'), bot('4')]);
    expect(runs[2]).toBeNull();
    expect(runs[0]?.key).not.toBe(runs[3]?.key);
  });

  it('unifies protocol messages and notices while retaining old drawer keys as aliases', () => {
    const messages = [bot('1', { protocol: { version: 1, mode: 'fix', state: 'TURN' } }), bot('2'), bot('3'),
      bot('n1', { systemEvent: 'agent_session' }), bot('n2', { systemEvent: 'agent_session' }),
      bot('4'), bot('5'), bot('6')];
    const runs = computeMessageRuns(messages);
    expect(new Set(runs.map(run => run?.key))).toEqual(new Set(['agents:1']));
    expect(runs[0]).toMatchObject({ size: 8, noticeCount: 2, aliases: ['agents:1', 'n1', 'agents:4'] });
  });

  it.each([
    ['agent_tool_approval', 'once'], ['agent_tool_approval', 'always'], ['agent_run_approval', 'denied'],
    ['agent_handoff', 'accepted'], ['agent_permission_relay', 'allow'], ['runtime_result', 'succeeded'],
  ])('folds explicitly resolved %s cards, leaving pending/unknown states visible', (systemEvent, status) => {
    expect(isFoldableAgentUpdate(bot('card', { systemEvent, authorBot: false, systemData: { status } }))).toBe(true);
    expect(isFoldableAgentUpdate(bot('card', { systemEvent, systemData: { status: 'pending' } }))).toBe(false);
    expect(isFoldableAgentUpdate(bot('card', { systemEvent, systemData: { status: 'unknown' } }))).toBe(false);
  });

  it('drops measured heights when a live run forms, toggles, gains a footer row, or breaks', () => {
    let messages = [bot('1')];
    let runs = computeMessageRuns(messages);
    let expanded = false;
    const estimate = (index: number) => !runs[index] ? 64 : expanded ? 64 + (runs[index]?.position === 0 ? 48 : 0) + (runs[index]?.position === runs[index]!.size - 1 ? 48 : 0) : (runs[index]?.position === 0 ? 48 : 0);
    const v = new Virtualizer<HTMLDivElement, HTMLDivElement>({ count: 1, getScrollElement: () => null,
      estimateSize: estimate, scrollToFn: () => {}, observeElementRect: () => {}, observeElementOffset: () => {} });
    v._willUpdate(); v.getTotalSize();
    v.resizeItem(0, 200);
    const rows = () => messages.map((message, index) => ({ id: message.id, run: runs[index] }));
    let previous = rows();
    messages = [...messages, bot('2')]; runs = computeMessageRuns(messages);
    v.setOptions({ ...v.options, count: 2 }); v.getTotalSize();
    resizeChangedRunRows(v, previous, rows(), new Set(), offscreen(estimate, () => expanded));
    expect(v.getTotalSize()).toBe(48);
    expanded = true;
    resizeChangedRunRows(v, rows(), rows(), new Set(['agents:1']), offscreen(estimate, () => expanded));
    expect(v.getTotalSize()).toBe(224);
    previous = rows();
    messages = [...messages, bot('3')]; runs = computeMessageRuns(messages);
    v.setOptions({ ...v.options, count: 3 }); v.getTotalSize();
    resizeChangedRunRows(v, previous, rows(), new Set(), offscreen(estimate, () => expanded));
    expect(v.getTotalSize()).toBe(288);
    v.resizeItem(0, 240); v.resizeItem(1, 400); v.resizeItem(2, 600);
    expanded = false;
    resizeChangedRunRows(v, rows(), rows(), new Set(['agents:1']), offscreen(estimate, () => expanded));
    expect(v.getTotalSize()).toBe(48);
    previous = rows();
    messages = [messages[0], { ...messages[1], authorBot: false }, messages[2]];
    runs = computeMessageRuns(messages);
    resizeChangedRunRows(v, previous, rows(), new Set(), offscreen(estimate, () => expanded));
    expect(v.getTotalSize()).toBe(192);
  });

  it('keeps offscreen measured heights when only an alias or default changes, and measures mounted rows', () => {
    const messages = [bot('human', { authorBot: false }), bot('1'), bot('2'), bot('3')];
    const before = computeMessageRuns(messages);
    const withNotice = [...messages, bot('notice', { authorBot: false, systemEvent: 'agent_session' })];
    const after = computeMessageRuns(withNotice);
    expect(after[1]?.aliases).not.toEqual(before[1]?.aliases);
    const resized: [number, number][] = [];
    const list = { resizeItem: (index: number, size: number) => resized.push([index, size]) };
    const previous = messages.map((m, i) => ({ id: m.id, run: before[i] }));
    const next = withNotice.map((m, i) => ({ id: m.id, run: after[i] }));
    // Rows 1-2 render the same; row 3 loses the footer; the notice is new.
    resizeChangedRunRows(list, previous, next, new Set(), offscreen(() => 7, () => true));
    expect(resized).toEqual([[3, 7]]);
    resized.length = 0;
    resizeChangedRunRows(list, previous, next, new Set(), { ...offscreen(() => 7, () => true), measure: index => index * 100 });
    expect(resized).toEqual([[1, 100], [2, 200], [3, 300], [4, 400]]);
    // A human reply after a run the user holds open: the default flips, the run stays open.
    resized.length = 0;
    const replied = [...messages, bot('reply', { authorBot: false })];
    const repliedRuns = computeMessageRuns(replied);
    resizeChangedRunRows(list, previous, replied.map((m, i) => ({ id: m.id, run: repliedRuns[i] })), new Set(), offscreen(() => 7, () => true));
    expect(resized).toEqual([]);
    // The same reply on a run that was open only by default collapses it.
    resizeChangedRunRows(list, previous, replied.map((m, i) => ({ id: m.id, run: repliedRuns[i] })), new Set(), offscreen(() => 7, run => run.defaultExpanded));
    expect(resized).toEqual([[1, 7], [2, 7], [3, 7]]);
  });
});
