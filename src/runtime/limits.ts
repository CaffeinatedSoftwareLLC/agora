/**
 * Run resource limits (sandbox-isolation-spec §8). Defaults can be lowered by the
 * submitter, never raised; everything is clamped to hard ceilings.
 */

export interface RunLimits {
    cpus: number;
    memoryMb: number;
    pidsLimit: number;
    wallClockMs: number;
    scratchMb: number;
    /** Bytes of stdout and of stderr kept (each). */
    outputBytes: number;
    capabilityCalls: number;
    /** Files a run may post through the gateway. */
    artifacts: number;
}

export type TimeProfile = 'standard' | 'generation' | 'video';

export const DEFAULT_LIMITS: Omit<RunLimits, 'wallClockMs'> = {
    cpus: 1,
    memoryMb: 512,
    pidsLimit: 128,
    scratchMb: 64,
    outputBytes: 64 * 1024,
    capabilityCalls: 20,
    artifacts: 10,
};

export const HARD_CEILINGS: Omit<RunLimits, 'wallClockMs'> = {
    cpus: 2,
    memoryMb: 2048,
    pidsLimit: 512,
    scratchMb: 256,
    outputBytes: 256 * 1024,
    capabilityCalls: 200,
    artifacts: 50,
};

/** Wall clock follows what the run declares it will use (§8.1). */
export const TIME_PROFILES: Record<TimeProfile, { defaultMs: number; ceilingMs: number }> = {
    standard: { defaultMs: 60_000, ceilingMs: 300_000 },
    generation: { defaultMs: 180_000, ceilingMs: 600_000 },
    // Veo takes 11 s to 6 min per video (Google's docs, 2026-09); leave room for the download
    video: { defaultMs: 480_000, ceilingMs: 600_000 },
};

const GENERATION_CAPABILITIES = new Set(['image', 'tts']);

export function timeProfileFor(capabilities: readonly string[]): TimeProfile {
    if (capabilities.includes('video')) return 'video';
    return capabilities.some(c => GENERATION_CAPABILITIES.has(c)) ? 'generation' : 'standard';
}

/** Instance-level overrides of the defaults (instance_settings `runtime.*`); clamped to ceilings. */
export interface LimitOverrides {
    defaults?: Partial<Omit<RunLimits, 'wallClockMs'>>;
    profiles?: Partial<Record<TimeProfile, Partial<{ defaultMs: number; ceilingMs: number }>>>;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Effective limits for a run: instance defaults (clamped to ceilings), optionally
 * lowered by the submitter. Positive values only; anything invalid falls back to the default.
 */
export function resolveLimits(
    profile: TimeProfile,
    requested: Partial<RunLimits> = {},
    overrides: LimitOverrides = {},
): RunLimits {
    const out = {} as RunLimits;
    for (const key of Object.keys(DEFAULT_LIMITS) as (keyof typeof DEFAULT_LIMITS)[]) {
        const ceiling = HARD_CEILINGS[key];
        const base = clamp(overrides.defaults?.[key] ?? DEFAULT_LIMITS[key], 1, ceiling);
        const want = requested[key];
        out[key] = typeof want === 'number' && Number.isFinite(want) && want > 0 ? Math.min(want, base) : base;
    }

    const p = TIME_PROFILES[profile];
    const ceilingMs = clamp(overrides.profiles?.[profile]?.ceilingMs ?? p.ceilingMs, 1_000, p.ceilingMs);
    const defaultMs = clamp(overrides.profiles?.[profile]?.defaultMs ?? p.defaultMs, 1_000, ceilingMs);
    const wantMs = requested.wallClockMs;
    out.wallClockMs = typeof wantMs === 'number' && Number.isFinite(wantMs) && wantMs > 0 ? Math.min(wantMs, defaultMs) : defaultMs;
    return out;
}
