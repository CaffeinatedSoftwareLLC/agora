import type { Queryable } from './routing';

/**
 * Voice in and out (cloud handoff C4): push-to-talk transcription through the `stt`
 * route and agent replies read aloud through the `tts` route, with the browser's own
 * speech engines as admin-controlled fallbacks. Comparison and choices: docs/voice.md.
 */

export interface VoiceSettings {
    voiceInputEnabled: boolean;
    browserSttFallback: boolean;
    maxRecordingSeconds: number;
    sttLanguage: string | null;
    readAloudEnabled: boolean;
    readAloudServer: boolean;
    browserTtsFallback: boolean;
    readAloudVoice: string | null;
    readAloudMaxChars: number;
}

/** Column per setting, for PATCH and the audit snapshot. */
export const VOICE_COLUMNS: Record<keyof VoiceSettings, string> = {
    voiceInputEnabled: 'voice_input_enabled',
    browserSttFallback: 'browser_stt_fallback',
    maxRecordingSeconds: 'max_recording_seconds',
    sttLanguage: 'stt_language',
    readAloudEnabled: 'read_aloud_enabled',
    readAloudServer: 'read_aloud_server',
    browserTtsFallback: 'browser_tts_fallback',
    readAloudVoice: 'read_aloud_voice',
    readAloudMaxChars: 'read_aloud_max_chars',
};

/** Matches the migration's defaults, for servers with no row. */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
    voiceInputEnabled: true,
    browserSttFallback: false,
    maxRecordingSeconds: 120,
    sttLanguage: null,
    readAloudEnabled: true,
    readAloudServer: false,
    browserTtsFallback: true,
    readAloudVoice: null,
    readAloudMaxChars: 1500,
};

export function voiceSettingsFromRow(row: any): VoiceSettings {
    if (!row) return { ...DEFAULT_VOICE_SETTINGS };
    return Object.fromEntries(
        (Object.keys(VOICE_COLUMNS) as (keyof VoiceSettings)[]).map(key => [key, row[VOICE_COLUMNS[key]] ?? null]),
    ) as unknown as VoiceSettings;
}

export async function loadVoiceSettings(db: Queryable, serverId: string): Promise<VoiceSettings> {
    const res = await db.query('SELECT * FROM ai_voice_settings WHERE server_id = $1', [serverId]);
    return voiceSettingsFromRow(res.rows[0]);
}

/** Whether a capability route exists and is usable, without decrypting anything. */
export async function voiceRouteStates(db: Queryable, serverId: string) {
    const res = await db.query(
        `SELECT r.capability, r.enabled, r.model, p.label, p.adapter, p.enabled AS provider_enabled
         FROM ai_capability_routes r JOIN ai_providers p ON p.id = r.provider_id
         WHERE r.server_id = $1 AND r.capability IN ('stt', 'tts')`,
        [serverId]
    );
    const state = (capability: 'stt' | 'tts') => {
        const r = res.rows.find((row: any) => row.capability === capability);
        return r
            ? { configured: true, enabled: !!(r.enabled && r.provider_enabled), provider: r.label as string, adapter: r.adapter as string, model: r.model as string }
            : { configured: false, enabled: false, provider: null, adapter: null, model: null };
    };
    return { stt: state('stt'), tts: state('tts') };
}

export type VoiceEngine = 'server' | 'browser' | 'off';

/** Which engine a member's client uses in each direction. */
export function voiceEngines(settings: VoiceSettings, routes: { stt: { enabled: boolean }; tts: { enabled: boolean } }): { input: VoiceEngine; output: VoiceEngine } {
    const input: VoiceEngine = !settings.voiceInputEnabled ? 'off'
        : routes.stt.enabled ? 'server'
        : settings.browserSttFallback ? 'browser' : 'off';
    const output: VoiceEngine = !settings.readAloudEnabled ? 'off'
        : settings.readAloudServer && routes.tts.enabled ? 'server'
        : settings.browserTtsFallback ? 'browser' : 'off';
    return { input, output };
}

// ─── Text to read ───

const MENTION = /<@([0-9A-HJKMNP-TV-Z]{26})>/g;

/** ULIDs a message mentions as `<@id>`, to look their names up before `speakableText`. */
export function mentionedIds(text: string): string[] {
    return [...new Set([...text.matchAll(MENTION)].map(m => m[1]))];
}

/**
 * Markdown → text worth hearing. Code blocks and URLs are named, not read out;
 * formatting marks are dropped; lines become sentences. Cut at `maxChars` on a
 * sentence (or word) boundary. Mirrored for the browser engine in
 * agora-ui/src/features/voice/speakable.ts; keep the two in step.
 */
export function speakableText(markdown: string, maxChars: number, names: Map<string, string> = new Map()): string {
    let text = markdown
        .replace(/```[\s\S]*?(```|$)/g, '\n(code block)\n')
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt) => alt ? `(image: ${alt})` : '(image)')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, '(link)')
        .replace(MENTION, (_, id) => `@${names.get(id) ?? 'someone'}`)
        .replace(/`([^`]*)`/g, '$1')
        .replace(/<\/?[a-z][^>]*>/gi, '');

    const lines = text.split('\n').map(line => line
        .replace(/^\s*([-*_])(\s*\1){2,}\s*$/, '')                 // horizontal rule
        .replace(/^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-*:?\s*$/, '')   // table rule
        .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/, '')
        .split('|').map(cell => cell.trim()).filter(Boolean).join(', ')
        .replace(/(\*\*|~~)(?=\S)(.+?)\1/g, '$2')
        .replace(/\*(?=\S)([^*]+?)\*/g, '$1')
        // _emphasis_ only at word edges, so snake_case names keep their underscores
        .replace(/(^|\W)(__?)(?=\S)(.+?)\2(?=\W|$)/g, '$1$3')
        .replace(/\s+/g, ' ')
        .trim())
        .filter(Boolean);
    text = lines.map(l => /[.!?:;…]$/.test(l) ? l : `${l}.`).join(' ');

    if (text.length <= maxChars) return text;
    const cut = text.slice(0, maxChars);
    const sentence = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    const end = sentence > maxChars / 2 ? sentence + 1 : Math.max(cut.lastIndexOf(' '), maxChars / 2);
    return `${cut.slice(0, end).trim()} The rest is in the message.`;
}

// ─── Audio cache ───

/**
 * Recently voiced messages, so a reply heard on the phone and again on the PC (or
 * replayed) is synthesised and billed once. In-process; a restart empties it.
 */
const CACHE_MAX_ENTRIES = 64;
const CACHE_MAX_BYTES = 32 * 1024 * 1024;
const cache = new Map<string, { data: Buffer; mime: string }>();
let cacheBytes = 0;

export function cachedSpeech(key: string): { data: Buffer; mime: string } | undefined {
    const hit = cache.get(key);
    if (hit) { cache.delete(key); cache.set(key, hit); } // most recently used last
    return hit;
}

export function cacheSpeech(key: string, value: { data: Buffer; mime: string }): void {
    if (value.data.length > CACHE_MAX_BYTES / 4) return;
    const old = cache.get(key);
    if (old) { cacheBytes -= old.data.length; cache.delete(key); }
    cache.set(key, value);
    cacheBytes += value.data.length;
    for (const [k, v] of cache) {
        if (cache.size <= CACHE_MAX_ENTRIES && cacheBytes <= CACHE_MAX_BYTES) break;
        cache.delete(k);
        cacheBytes -= v.data.length;
    }
}

export function clearSpeechCache(): void {
    cache.clear();
    cacheBytes = 0;
}
