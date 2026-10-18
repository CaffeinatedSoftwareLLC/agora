import { REDACTED_PRIVATE_KEY, redactPrivateKeys, sanitizeMessageText, stripEscapes } from '../../src/lib/sanitize-text';

// Built from code points so this file holds no raw control characters
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const ST = ESC + String.fromCharCode(0x5c); // ESC \ (string terminator)

describe('stripEscapes (#88)', () => {
    test('removes colour and cursor sequences, keeps the text', () => {
        expect(stripEscapes(`${ESC}[1;31mFAIL${ESC}[0m test.ts`)).toBe('FAIL test.ts');
        expect(stripEscapes(`a${ESC}[2K${ESC}[1Gb${ESC}[?25l`)).toBe('ab');
        expect(stripEscapes(`x${CSI}31my`)).toBe('xy');
    });

    test('removes OSC strings: titles, hyperlinks, clipboard writes', () => {
        expect(stripEscapes(`${ESC}]0;pwned${BEL}ok`)).toBe('ok');
        expect(stripEscapes(`${ESC}]8;;https://evil.example${ST}click${ESC}]8;;${ST}`)).toBe('click');
        expect(stripEscapes(`before${ESC}]52;c;cm0gLXJmIH4=${BEL}after`)).toBe('beforeafter');
    });

    test('an unterminated OSC string swallows the rest, as a terminal would', () => {
        expect(stripEscapes(`keep${ESC}]52;c;cm0gLXJmIH4=`)).toBe('keep');
    });

    test('removes short escapes and a lone ESC', () => {
        expect(stripEscapes(`${ESC}(Bplain${ESC}7${ESC}8 ${ESC}`)).toBe('plain ');
    });

    test('leaves ordinary text, tabs, line breaks and brackets alone', () => {
        const text = 'line one\n\tline [two] ]three[ \r\nemoji: \u{1F331} ü';
        expect(stripEscapes(text)).toBe(text);
    });
});

describe('redactPrivateKeys (#88)', () => {
    const body = 'MIIEowIBAAKCAQEA1x2y3z\nAbCdEfGh+/==\n';

    test.each([
        'PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY',
        'ENCRYPTED PRIVATE KEY', 'DSA PRIVATE KEY', 'PGP PRIVATE KEY BLOCK',
    ])('redacts a %s block and keeps the text around it', (label: string) => {
        const text = `here is my key:\n-----BEGIN ${label}-----\n${body}-----END ${label}-----\nthanks`;
        expect(redactPrivateKeys(text)).toBe(`here is my key:\n${REDACTED_PRIVATE_KEY}\nthanks`);
    });

    test('redacts every block in a message', () => {
        const block = `-----BEGIN PRIVATE KEY-----\n${body}-----END PRIVATE KEY-----`;
        expect(redactPrivateKeys(`${block} and ${block}`)).toBe(`${REDACTED_PRIVATE_KEY} and ${REDACTED_PRIVATE_KEY}`);
    });

    test('redacts a block cut off before its END line', () => {
        expect(redactPrivateKeys(`oops\n-----BEGIN RSA PRIVATE KEY-----\n${body}`)).toBe(`oops\n${REDACTED_PRIVATE_KEY}`);
    });

    test('leaves public keys and certificates alone', () => {
        const pub = `-----BEGIN PUBLIC KEY-----\n${body}-----END PUBLIC KEY-----`;
        const cert = `-----BEGIN CERTIFICATE-----\n${body}-----END CERTIFICATE-----`;
        expect(redactPrivateKeys(pub)).toBe(pub);
        expect(redactPrivateKeys(cert)).toBe(cert);
    });
});

describe('sanitizeMessageText (#88)', () => {
    test('colour codes cannot hide a key block from the redaction', () => {
        const text = `${ESC}[32m-----BEGIN ${ESC}[0mOPENSSH PRIVATE KEY-----\nb3BlbnNzaA==\n-----END OPENSSH PRIVATE KEY-----`;
        expect(sanitizeMessageText(text)).toBe(REDACTED_PRIVATE_KEY);
    });

    test('plain text passes through unchanged', () => {
        expect(sanitizeMessageText('@codex review PR 62, please')).toBe('@codex review PR 62, please');
    });
});
