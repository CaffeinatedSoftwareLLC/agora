import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

export function generateUlid(): string {
    return ulid();
}
