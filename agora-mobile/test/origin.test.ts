import { describe, expect, it } from 'vitest';
import { isSavedOrigin, normalizeOrigin, resolveDeepLink, resolveInstancePath } from '../src/lib/origin';

describe('normalizeOrigin', () => {
    it.each([
        ['https://agora.example.com', 'https://agora.example.com'],
        ['https://agora.example.com/', 'https://agora.example.com'],
        ['  https://Agora.Example.COM  ', 'https://agora.example.com'],
        ['agora.example.com', 'https://agora.example.com'],
        ['https://agora.example.com:443', 'https://agora.example.com'],
        ['https://agora.example.com:8443', 'https://agora.example.com:8443'],
        ['https://box.tail1234.ts.net', 'https://box.tail1234.ts.net'],
        ['https://[::1]:8443', 'https://[::1]:8443'],
    ])('accepts %s', (input, expected) => {
        expect(normalizeOrigin(input)).toBe(expected);
    });

    it.each([
        'http://agora.example.com',
        'ftp://agora.example.com',
        'javascript:alert(1)',
        'https://agora.example.com/app',
        'https://agora.example.com/?x=1',
        'https://agora.example.com/#x',
        'https://user:pass@agora.example.com',
        'https://user@agora.example.com',
        'https://localhost',
        'https://localhost:3000',
        'https://agora.example.com\\@evil.com',
        'https://agora .example.com',
        '',
        '   ',
        'https://',
    ])('refuses %s', (input) => {
        expect(normalizeOrigin(input)).toBeNull();
    });
});

describe('isSavedOrigin', () => {
    it('matches exact origins only', () => {
        const saved = ['https://a.example.com', 'https://b.example.com:8443'];
        expect(isSavedOrigin('https://a.example.com', saved)).toBe(true);
        expect(isSavedOrigin('https://b.example.com:8443', saved)).toBe(true);
        expect(isSavedOrigin('https://b.example.com', saved)).toBe(false);
        expect(isSavedOrigin('https://x.a.example.com', saved)).toBe(false);
        expect(isSavedOrigin('http://a.example.com', saved)).toBe(false);
    });
});

describe('resolveInstancePath', () => {
    const origin = 'https://agora.example.com';

    it.each([
        ['/app/01HZX', 'https://agora.example.com/app/01HZX'],
        ['/app/01HZX?thread=01HZY', 'https://agora.example.com/app/01HZX?thread=01HZY'],
        ['/', 'https://agora.example.com/'],
    ])('resolves %s on the origin', (path, expected) => {
        expect(resolveInstancePath(origin, path)).toBe(expected);
    });

    it.each([
        '//evil.com/app',
        '/\\evil.com',
        '\\\\evil.com',
        'https://evil.com/app',
        'javascript:alert(1)',
        'app/01HZX',
        '',
        '/app/\nx',
        '/app/ x',
        '/app/\u0000',
        42,
        null,
        undefined,
        `/${'a'.repeat(2048)}`,
    ])('refuses %j', (path) => {
        expect(resolveInstancePath(origin, path)).toBeNull();
    });

    it('cannot leave the origin with dot segments', () => {
        expect(resolveInstancePath(origin, '/../../x')).toBe('https://agora.example.com/x');
    });
});

describe('resolveDeepLink', () => {
    const saved = ['https://a.example.com', 'https://b.example.com'];
    const all = () => true;

    it('opens the url on the saved instance that sent it', () => {
        expect(resolveDeepLink({ instance: 'https://b.example.com', url: '/app/01A?thread=01B' }, saved, all))
            .toBe('https://b.example.com/app/01A?thread=01B');
    });

    it('opens the instance root when the url is missing', () => {
        expect(resolveDeepLink({ instance: 'https://a.example.com' }, saved, all)).toBe('https://a.example.com/');
    });

    it('ignores instances that are not saved', () => {
        expect(resolveDeepLink({ instance: 'https://evil.example.com', url: '/app/x' }, saved, all)).toBeNull();
    });

    it('ignores instances without a handle from this device', () => {
        expect(resolveDeepLink({ instance: 'https://a.example.com', url: '/app/x' }, saved, (o) => o !== 'https://a.example.com')).toBeNull();
    });

    it('requires the exact origin form', () => {
        expect(resolveDeepLink({ instance: 'https://A.example.com', url: '/app/x' }, saved, all)).toBeNull();
        expect(resolveDeepLink({ instance: 'https://a.example.com/', url: '/app/x' }, saved, all)).toBeNull();
    });

    it('refuses urls that leave the instance', () => {
        expect(resolveDeepLink({ instance: 'https://a.example.com', url: '//b.example.com/app' }, saved, all)).toBeNull();
        expect(resolveDeepLink({ instance: 'https://a.example.com', url: 'https://b.example.com/app' }, saved, all)).toBeNull();
    });

    it('handles junk', () => {
        expect(resolveDeepLink(null, saved, all)).toBeNull();
        expect(resolveDeepLink({}, saved, all)).toBeNull();
        expect(resolveDeepLink({ instance: 7, url: '/' }, saved, all)).toBeNull();
    });
});
