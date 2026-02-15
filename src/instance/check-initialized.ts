let initialized: boolean | null = null;

export async function isInstanceInitialized(db: any): Promise<boolean> {
    if (initialized === true) return true;
    const result = await db.query(
        "SELECT value FROM instance_config WHERE key = 'setup_complete'"
    );
    if (result.rows.length > 0 && result.rows[0].value === 'true') {
        initialized = true;
        return true;
    }
    return false;
}

export function resetInitializedCache(): void {
    initialized = null;
}
