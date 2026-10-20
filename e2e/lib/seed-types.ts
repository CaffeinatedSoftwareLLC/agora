export interface SeedUser { id: string; username: string; email: string }

/** Written to secrets/seed.json by global-setup; deleted by global-teardown. */
export interface Seed {
    runTag: string;
    serverId: string;
    channels: { general: string; agents: string; notices: string; history: string };
    users: { owner: SeedUser; member: SeedUser };
    hostId: string;
    agents: {
        claude: { profileId: string; botId: string; name: string };   // api_key
        codexKey: { profileId: string; botId: string; name: string }; // codex, api_key
        codexSub: { profileId: string; botId: string; name: string }; // codex, subscription
        codexPlan: { profileId: string; botId: string; name: string };// codex, siwc
    };
    /** Values the leak scanner looks for. Never logged, never uploaded. */
    secrets: { ownerPassword: string; memberPassword: string; ownerToken: string; memberToken: string; botToken: string; hostToken: string };
}
