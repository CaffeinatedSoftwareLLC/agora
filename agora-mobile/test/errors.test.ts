import { describe, expect, it } from 'vitest';
import { errorDetail, MESSAGES, ProbeError, probeFailureMessage } from '../src/lib/errors';

describe('probeFailureMessage', () => {
    it('says the server cannot be reached for network failures', () => {
        expect(probeFailureMessage(new ProbeError('unreachable', 'failed to connect to x after 8000ms'))).toBe(
            "Can't reach this server. Check your network or VPN, then try again.",
        );
    });

    it('says the address is not Agora for wrong answers', () => {
        expect(probeFailureMessage(new ProbeError('not_agora', '/health returned 404'))).toBe("This address doesn't look like an Agora server.");
    });

    it('never shows raw exception text', () => {
        for (const err of [
            new Error('failed to connect to agora.example.com/100.64.0.1 (port 443) after 8000ms'),
            new Error('Unable to resolve host "agora.example.com": No address associated with hostname'),
            new TypeError('Failed to fetch'),
            'java.net.ConnectException: Connection refused',
            { message: 'SSL handshake aborted' },
            undefined,
        ]) {
            expect(probeFailureMessage(err)).toBe(MESSAGES.unreachable);
        }
    });

    it('keeps the https hint', () => {
        expect(MESSAGES.notHttps).toBe('Enter an https:// address with no path, like https://agora.example.com.');
    });
});

describe('errorDetail', () => {
    it('keeps the technical text for the log', () => {
        expect(errorDetail(new ProbeError('unreachable', 'GET https://a/health: timeout'))).toBe('unreachable: GET https://a/health: timeout');
        expect(errorDetail(new Error('boom'))).toBe('boom');
        expect(errorDetail('plain')).toBe('plain');
    });
});
