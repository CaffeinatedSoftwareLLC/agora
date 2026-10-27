/**
 * What the picker tells the user when adding a server fails. Raw exception text
 * (CapacitorHttp's "failed to connect to ... after 8000ms", SSL errors, status
 * codes) never reaches the screen; the picker logs it with console.warn instead.
 */
export const MESSAGES = {
    notHttps: 'Enter an https:// address with no path, like https://agora.example.com.',
    unreachable: "Can't reach this server. Check your network or VPN, then try again.",
    notAgora: "This address doesn't look like an Agora server.",
    saveFailed: "Couldn't save this server. Try again.",
} as const;

/** `unreachable`: no HTTP answer (network down, VPN off, DNS, refused, timeout, TLS). `not_agora`: an answer, but not Agora's. */
export type ProbeFailure = 'unreachable' | 'not_agora';

export class ProbeError extends Error {
    /** @param detail technical text for the log, never shown */
    constructor(readonly kind: ProbeFailure, readonly detail: string) {
        super(probeMessage(kind));
        this.name = 'ProbeError';
    }
}

function probeMessage(kind: ProbeFailure): string {
    return kind === 'not_agora' ? MESSAGES.notAgora : MESSAGES.unreachable;
}

/**
 * The text to show for anything probeInstance threw. Its HTTP failures are wrapped
 * in ProbeError; anything else it can throw is a transport failure, so it reads as
 * unreachable too.
 */
export function probeFailureMessage(err: unknown): string {
    return err instanceof ProbeError ? probeMessage(err.kind) : MESSAGES.unreachable;
}

/** The technical text to log for a failure (never shown to the user). */
export function errorDetail(err: unknown): string {
    if (err instanceof ProbeError) return `${err.kind}: ${err.detail}`;
    if (err instanceof Error) return err.message || err.name;
    return String(err);
}
