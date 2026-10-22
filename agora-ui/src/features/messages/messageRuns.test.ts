import { describe, expect, it } from 'vitest';
import { Virtualizer } from '@tanstack/virtual-core';
import type { Message } from '../../stores/messageStore';
import { computeMessageRuns, isFoldableAgentMessage, isFoldableAgentUpdate, resizeChangedRunRows } from './messageRuns';

const bot = (id: string, extra: Partial<Message> = {}): Message => ({
  id, content: id, authorId: 'claude', authorUsername: 'Claude', authorBot: true,
  channelId: 'channel', createdAt: '2026-10-22T00:00:00Z', ...extra,
});

describe('agent message runs', () => {
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
    resizeChangedRunRows(v, previous, rows(), new Set(), estimate);
    expect(v.getTotalSize()).toBe(48);
    expanded = true;
    resizeChangedRunRows(v, rows(), rows(), new Set(['agents:1']), estimate);
    expect(v.getTotalSize()).toBe(224);
    previous = rows();
    messages = [...messages, bot('3')]; runs = computeMessageRuns(messages);
    v.setOptions({ ...v.options, count: 3 }); v.getTotalSize();
    resizeChangedRunRows(v, previous, rows(), new Set(), estimate);
    expect(v.getTotalSize()).toBe(288);
    v.resizeItem(0, 240); v.resizeItem(1, 400); v.resizeItem(2, 600);
    expanded = false;
    resizeChangedRunRows(v, rows(), rows(), new Set(['agents:1']), estimate);
    expect(v.getTotalSize()).toBe(48);
    previous = rows();
    messages = [messages[0], { ...messages[1], authorBot: false }, messages[2]];
    runs = computeMessageRuns(messages);
    resizeChangedRunRows(v, previous, rows(), new Set(), estimate);
    expect(v.getTotalSize()).toBe(192);
  });
});
