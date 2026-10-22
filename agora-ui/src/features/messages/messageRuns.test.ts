import { describe, expect, it } from 'vitest';
import { Virtualizer } from '@tanstack/virtual-core';
import type { Message } from '../../stores/messageStore';
import { computeMessageRuns, isFoldableAgentMessage, resizeChangedRunRows } from './messageRuns';

const bot = (id: string, extra: Partial<Message> = {}): Message => ({
  id, content: id, authorId: 'claude', authorUsername: 'Claude', authorBot: true,
  channelId: 'channel', createdAt: '2026-10-22T00:00:00Z', ...extra,
});

describe('agent message runs', () => {
  it('folds three or more messages, counts all authors and keeps pairs visible', () => {
    expect(computeMessageRuns([bot('1'), bot('2')])).toEqual([null, null]);
    const runs = computeMessageRuns([bot('1'), bot('2', { authorId: 'codex', authorUsername: 'Codex' }), bot('3')]);
    expect(runs.map(run => run?.position)).toEqual([0, 1, 2]);
    expect(runs[0]).toMatchObject({ kind: 'agents', key: 'agents:1', size: 3, names: ['Claude', 'Codex'] });
  });

  it.each([
    { authorBot: false }, { authorBot: undefined }, { deletedAt: 'now' }, { pending: true },
    { failed: true }, { streaming: true }, { systemEvent: 'agent_run_approval' },
    { systemEvent: 'runtime_report' }, { systemEvent: 'agent_session' },
    { artifact: { id: 'artifact' } }, { attachments: [{ id: 'file' }] },
  ] as Partial<Message>[])('keeps a separator visible and breaks adjacent pairs: %j', separator => {
    const middle = bot('middle', separator);
    expect(isFoldableAgentMessage(middle)).toBe(false);
    expect(computeMessageRuns([bot('1'), bot('2'), middle, bot('3'), bot('4')])).toEqual([null, null, null, null, null]);
  });

  it('preserves protocol messages and separate system notice drawers', () => {
    const messages = [bot('1', { protocol: { version: 1, mode: 'fix', state: 'TURN' } }), bot('2'), bot('3'),
      bot('n1', { systemEvent: 'agent_session' }), bot('n2', { systemEvent: 'agent_session' }),
      bot('4'), bot('5'), bot('6')];
    const runs = computeMessageRuns(messages);
    expect(runs.map(run => run?.kind)).toEqual(['agents', 'agents', 'agents', 'notices', 'notices', 'agents', 'agents', 'agents']);
    expect(runs[5]?.key).toBe('agents:4');
  });

  it('drops measured heights when the third live message forms a run, toggles, or a human breaks it', () => {
    let messages = [bot('1'), bot('2')];
    let runs = computeMessageRuns(messages);
    let expanded = false;
    const estimate = (index: number) => !runs[index] ? 64 : expanded ? (runs[index]?.position === 0 ? 112 : 64) : (runs[index]?.position === 0 ? 48 : 0);
    const v = new Virtualizer<HTMLDivElement, HTMLDivElement>({ count: 2, getScrollElement: () => null,
      estimateSize: estimate, scrollToFn: () => {}, observeElementRect: () => {}, observeElementOffset: () => {} });
    v._willUpdate(); v.getTotalSize();
    v.resizeItem(0, 200); v.resizeItem(1, 300);
    const rows = () => messages.map((message, index) => ({ id: message.id, run: runs[index] }));
    let previous = rows();
    messages = [...messages, bot('3')]; runs = computeMessageRuns(messages);
    v.setOptions({ ...v.options, count: 3 }); v.getTotalSize();
    resizeChangedRunRows(v, previous, rows(), new Set(), estimate);
    expect(v.getTotalSize()).toBe(48);
    expanded = true;
    resizeChangedRunRows(v, rows(), rows(), new Set(['agents:1']), estimate);
    expect(v.getTotalSize()).toBe(240);
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
