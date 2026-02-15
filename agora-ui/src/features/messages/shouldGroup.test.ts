import { describe, it, expect } from 'vitest';
import { shouldGroup, GROUP_THRESHOLD_MS, estimateMessageHeight, computePrependShift } from './grouping';

function msg(authorId: string, createdAt: string, deletedAt?: string) {
  return { authorId, createdAt, deletedAt };
}

const BASE_TIME = '2025-01-15T12:00:00.000Z';

function offsetMs(ms: number): string {
  return new Date(new Date(BASE_TIME).getTime() + ms).toISOString();
}

describe('shouldGroup', () => {
  it('returns false when there is no previous message', () => {
    expect(shouldGroup(undefined, msg('u1', BASE_TIME))).toBe(false);
  });

  it('groups consecutive messages from same author within threshold', () => {
    const prev = msg('u1', BASE_TIME);
    const curr = msg('u1', offsetMs(60_000)); // 1 minute later
    expect(shouldGroup(prev, curr)).toBe(true);
  });

  it('does not group messages from different authors', () => {
    const prev = msg('u1', BASE_TIME);
    const curr = msg('u2', offsetMs(60_000));
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('does not group when time gap exceeds threshold', () => {
    const prev = msg('u1', BASE_TIME);
    const curr = msg('u1', offsetMs(GROUP_THRESHOLD_MS)); // exactly at threshold
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('groups when time gap is just under threshold', () => {
    const prev = msg('u1', BASE_TIME);
    const curr = msg('u1', offsetMs(GROUP_THRESHOLD_MS - 1));
    expect(shouldGroup(prev, curr)).toBe(true);
  });

  it('does not group when previous message is deleted', () => {
    const prev = msg('u1', BASE_TIME, '2025-01-15T12:01:00.000Z');
    const curr = msg('u1', offsetMs(60_000));
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('does not group when current message is deleted', () => {
    const prev = msg('u1', BASE_TIME);
    const curr = msg('u1', offsetMs(60_000), '2025-01-15T12:02:00.000Z');
    expect(shouldGroup(prev, curr)).toBe(false);
  });

  it('does not group when both messages are deleted', () => {
    const prev = msg('u1', BASE_TIME, BASE_TIME);
    const curr = msg('u1', offsetMs(60_000), offsetMs(60_000));
    expect(shouldGroup(prev, curr)).toBe(false);
  });
});

describe('estimateMessageHeight', () => {
  it('returns 64 for a standalone non-deleted message', () => {
    expect(estimateMessageHeight(undefined, msg('u1', BASE_TIME))).toBe(64);
  });

  it('returns 28 for a grouped non-deleted message', () => {
    const prev = msg('u1', BASE_TIME);
    const curr = msg('u1', offsetMs(1000));
    expect(estimateMessageHeight(prev, curr)).toBe(28);
  });

  it('returns 48 for a standalone deleted message', () => {
    const curr = msg('u1', BASE_TIME, BASE_TIME);
    expect(estimateMessageHeight(undefined, curr)).toBe(48);
  });

  it('returns 28 for a grouped deleted message (same author, within threshold, prev not deleted)', () => {
    // Note: shouldGroup returns false when curr is deleted, so "grouped deleted" can't happen.
    // The function still returns the standalone-deleted height (48) because shouldGroup → false.
    const prev = msg('u1', BASE_TIME);
    const curr = msg('u1', offsetMs(1000), offsetMs(1000));
    expect(estimateMessageHeight(prev, curr)).toBe(48);
  });

  it('returns 64 for messages from different authors', () => {
    const prev = msg('u1', BASE_TIME);
    const curr = msg('u2', offsetMs(1000));
    expect(estimateMessageHeight(prev, curr)).toBe(64);
  });
});

describe('computePrependShift', () => {
  it('returns 0 for zero prepended items', () => {
    expect(computePrependShift([], 0)).toBe(0);
  });

  it('returns 64 for a single standalone prepended message', () => {
    const messages = [msg('u1', BASE_TIME)];
    expect(computePrependShift(messages, 1)).toBe(64);
  });

  it('sums heights correctly for multiple prepended messages', () => {
    // 3 messages from the same author, close together → first is standalone (64), next two grouped (28 each)
    const messages = [
      msg('u1', BASE_TIME),
      msg('u1', offsetMs(1000)),
      msg('u1', offsetMs(2000)),
      msg('u2', offsetMs(60_000)), // existing message (not prepended)
    ];
    // msg[0]: no prev → 64
    // msg[1]: grouped with msg[0] → 28
    // msg[2]: grouped with msg[1] → 28
    expect(computePrependShift(messages, 3)).toBe(64 + 28 + 28);
  });

  it('handles mixed authors in prepended messages', () => {
    const messages = [
      msg('u1', BASE_TIME),         // standalone → 64
      msg('u2', offsetMs(1000)),     // different author → 64
      msg('u2', offsetMs(2000)),     // grouped → 28
    ];
    expect(computePrependShift(messages, 3)).toBe(64 + 64 + 28);
  });

  it('handles deleted messages in prepended range', () => {
    const messages = [
      msg('u1', BASE_TIME, BASE_TIME), // standalone deleted → 48
      msg('u1', offsetMs(1000)),         // prev deleted → not grouped → 64
    ];
    expect(computePrependShift(messages, 2)).toBe(48 + 64);
  });

  it('only sums the first prependedCount items', () => {
    const messages = [
      msg('u1', BASE_TIME),         // prepended → 64
      msg('u2', offsetMs(60_000)),   // not prepended (existing)
      msg('u2', offsetMs(61_000)),   // not prepended (existing)
    ];
    expect(computePrependShift(messages, 1)).toBe(64);
  });
});
