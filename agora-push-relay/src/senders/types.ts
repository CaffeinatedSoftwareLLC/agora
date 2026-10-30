/** What reaches the device. `instance` comes from the relay's store, never from the push body. */
export interface PushMessage {
    type: string;
    title: string;
    body: string;
    url: string;
    instance: string;
}

export type SendResult =
    | { ok: true }
    /** `gone`: the provider says the token will never work again. `reason` is a short code, never payload text. */
    | { ok: false; gone: boolean; reason: string };

export interface Sender {
    send(token: string, message: PushMessage): Promise<SendResult>;
    close?(): Promise<void>;
}

/** Notifications stay deliverable for a day; an approval older than that is stale. */
export const PUSH_TTL_SECONDS = 86_400;

/** The iOS notification category the app registers Approve/Deny actions on. */
export const APPROVAL_CATEGORY = 'AGORA_APPROVAL';
