import { describe, it, expect } from 'vitest';
import { shouldGroup, GROUP_THRESHOLD_MS } from './grouping';

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
