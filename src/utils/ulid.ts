import { decodeTime, monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

export function generateUlid(): string {
    return ulid();
}

/** When a ULID was made, as an ISO time. */
export function ulidTime(id: string): string {
    return new Date(decodeTime(id.trim())).toISOString();
}

/** The smallest ULID made at `ms`, for `id >= …` range scans on a ULID primary key. */
export function ulidFloor(ms: number): string {
    const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let t = Math.max(0, Math.floor(ms)), out = '';
    for (let i = 0; i < 10; i++) { out = ALPHABET[t % 32] + out; t = Math.floor(t / 32); }
    return out + '0'.repeat(16);
}
