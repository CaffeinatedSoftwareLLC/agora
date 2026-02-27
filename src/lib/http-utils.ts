/**
 * Percent-encode per RFC 5987 attr-char rules for Content-Disposition filename*.
 * Allowed unencoded: A-Z a-z 0-9 ! # $ & + - . ^ _ ` | ~
 */
export function encodeRfc5987(str: string): string {
    return Array.from(Buffer.from(str, 'utf-8'))
        .map(byte => {
            const char = String.fromCharCode(byte);
            if (/[A-Za-z0-9!#$&+\-.^_`|~]/.test(char)) return char;
            return '%' + byte.toString(16).toUpperCase().padStart(2, '0');
        })
        .join('');
}
