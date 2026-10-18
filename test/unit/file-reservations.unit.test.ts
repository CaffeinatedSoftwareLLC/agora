import { normalizeReservationPath as norm, noticePathList, reservationPathsOverlap as overlap } from '../../src/lib/file-reservations';

it('normalizes case, Unicode, Windows separators, dot segments and directory prefixes', () => {
    expect(norm('.\\SRC\\Folder\\')).toBe('src/folder/');
    expect(norm('src//./File.ts')).toBe('src/file.ts');
    expect(norm('e\u0301.txt')).toBe('é.txt');
});
it.each(['../escape', 'src/../file', '/root', 'C:\\repo\\file', '\\\\server\\share', '*.ts', 'src/**', 'file?.ts', '[ab].ts', '.', 'src/file.', 'src/file ', 'a\0b'])('rejects ambiguous/absolute/glob path %j', p => {
    expect(() => norm(p)).toThrow('invalid_reservation_path');
});
it('compares exact files and explicit prefixes with directory boundaries', () => {
    expect(overlap('src/', 'src/a.ts')).toBe(true);
    expect(overlap('src/a.ts', 'src/')).toBe(true);
    expect(overlap('src/', 'src')).toBe(true);
    expect(overlap('src/', 'src2/a.ts')).toBe(false);
    expect(overlap('src/a', 'src/ab')).toBe(false);
    expect(overlap('src/a', 'src/a')).toBe(true);
});
it('keeps notice path lists under the message limit and counts the rest', () => {
    expect(noticePathList(['a.ts', 'b.ts'])).toBe('"a.ts", "b.ts"');
    const many = Array.from({ length: 5000 }, (_, i) => `src/${'x'.repeat(50)}/${i}.ts`);
    const text = noticePathList(many, '\n');
    expect(text.length).toBeLessThan(3200);
    expect(text).toMatch(/\.\.\. and \d+ more$/);
});
