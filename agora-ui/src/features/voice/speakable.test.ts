import { describe, expect, it } from 'vitest';
import { speakableText } from './speakable';
import { appendDictation } from './appendDictation';

// The same cases as test/unit/voice.unit.test.ts: the browser engine and the server's Speech route read alike

describe('speakableText (browser mirror of src/ai/voice.ts)', () => {
  it('drops formatting, names code blocks and links instead of reading them', () => {
    const md = [
      '## Result',
      '',
      'Tests **pass** now, see [the PR](https://github.com/x/y/pull/1) or https://ci.example.com/run/9',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '- fixed `parseDialogue`',
      '- kept snake_case_names',
      '> quoted _note_',
    ].join('\n');
    expect(speakableText(md, 1000)).toBe(
      'Result. Tests pass now, see the PR or (link). (code block). fixed parseDialogue. kept snake_case_names. quoted note.');
  });

  it('reads mentions by name and images by their alt text', () => {
    const id = '01HZX5V3K8Q2W7M4N6P9R0S1T2';
    expect(speakableText(`<@${id}> look: ![chart of latency](/files/1)`, 500, new Map([[id, 'eryk']])))
      .toBe('@eryk look: (image: chart of latency).');
    expect(speakableText(`<@${id}> hi`, 500)).toBe('@someone hi.');
  });

  it('turns tables into short phrases and skips their rule lines', () => {
    expect(speakableText('| a | b |\n|---|---|\n| 1 | 2 |', 500)).toBe('a, b. 1, 2.');
  });

  it('cuts long text at a sentence and says so', () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    expect(speakableText(text, 200).endsWith('is here. The rest is in the message.')).toBe(true);
  });

  it('returns nothing for a message that is only formatting', () => {
    expect(speakableText('---\n\n***', 500)).toBe('');
  });
});

describe('appendDictation', () => {
  it('adds dictated text after the draft with one space', () => {
    expect(appendDictation('', ' run the tests ')).toBe('run the tests');
    expect(appendDictation('@codex', 'run the tests')).toBe('@codex run the tests');
    expect(appendDictation('@codex  \n', 'run')).toBe('@codex run');
    expect(appendDictation('keep', '   ')).toBe('keep');
  });
});
