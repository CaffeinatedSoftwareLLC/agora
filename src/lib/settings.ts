// Simple cache for instance settings with 60s TTL
let settingsCache: Record<string, any> | null = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 60000; // 60 seconds

export async function getFileSettings(db: any): Promise<Record<string, any>> {
    const now = Date.now();
    if (settingsCache && (now - cacheTimestamp) < CACHE_TTL_MS) {
        return settingsCache;
    }

    const res = await db.query(
        "SELECT key, value FROM instance_settings WHERE key LIKE 'files.%'"
    );

    const settings: Record<string, any> = {};
    for (const row of res.rows) {
        settings[row.key] = row.value;
    }

    settingsCache = settings;
    cacheTimestamp = now;
    return settings;
}

export async function getFileSetting(db: any, key: string): Promise<any> {
    const settings = await getFileSettings(db);
    return settings[key];
}

export function invalidateSettingsCache(): void {
    settingsCache = null;
    cacheTimestamp = 0;
}
