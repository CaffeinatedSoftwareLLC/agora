/** Fixed-window counter per key, in memory. One relay process, so no shared store. */
export class FixedWindowLimiter {
    private readonly windows = new Map<string, { start: number; count: number }>();

    constructor(
        private readonly limit: number,
        private readonly windowMs: number,
        private readonly now: () => number = Date.now,
    ) {}

    /** Counts one hit. `retryAfter` is in whole seconds. */
    take(key: string): { ok: boolean; retryAfter: number } {
        const now = this.now();
        let w = this.windows.get(key);
        if (!w || now - w.start >= this.windowMs) {
            if (this.windows.size >= 100_000) this.sweep();
            w = { start: now, count: 0 };
            this.windows.set(key, w);
        }
        w.count += 1;
        if (w.count <= this.limit) return { ok: true, retryAfter: 0 };
        return { ok: false, retryAfter: Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000)) };
    }

    sweep(): void {
        const now = this.now();
        for (const [key, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(key);
    }
}
