import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { PushNotifications } from '@capacitor/push-notifications';
import { RELAY_URL } from '../config';
import { deleteRelayHandle } from '../lib/bridge';
import { normalizeOrigin, resolveDeepLink, type PushData } from '../lib/origin';
import { errorDetail, MESSAGES, probeFailureMessage, readUnreachable, unreachableServerMessage } from '../lib/errors';
import { clearFlash, saveFlash, sessionStore, takeFlash } from '../lib/flash';
import { probeInstance } from '../lib/probe';
import { removeServer } from '../lib/removal';
import { handleKey, ServerStore, type SavedServer } from '../lib/servers';
import { AgoraShell } from '../lib/shell';
import { pushData, readPickerOpen, returnUrl } from '../lib/taps';
import { nativeBridgeMissing, WEBVIEW_TOO_OLD } from '../lib/webview';

const store = new ServerStore(Preferences);
const http = { request: (o: Parameters<typeof CapacitorHttp.request>[0]) => CapacitorHttp.request(o) };

const list = document.getElementById('servers') as HTMLUListElement;
const empty = document.getElementById('empty') as HTMLParagraphElement;
const form = document.getElementById('add') as HTMLFormElement;
const input = document.getElementById('address') as HTMLInputElement;
const addButton = document.getElementById('add-button') as HTMLButtonElement;
const status = document.getElementById('status') as HTMLParagraphElement;

let leaving = false;
/**
 * True from the moment the saved list is written until AgoraShell.serversChanged has
 * run. Nothing navigates meanwhile, so native never keeps a list the picker changed.
 */
let changing = false;
const flash = sessionStore(window);

function setStatus(text: string, error = false): void {
    status.textContent = text;
    status.classList.toggle('error', error);
}

/** Show a success line now and keep it for the picker reload that serversChanged may cause. */
function announce(text: string): void {
    setStatus(text);
    saveFlash(flash, text);
}

async function open(origin: string, url?: string): Promise<void> {
    if (changing) return;
    leaving = true;
    clearFlash(flash);
    await store.setLastUsed(origin);
    // A plain navigation: AgoraShell lets saved origins load in the WebView, and
    // Back from the instance's first page returns here.
    window.location.assign(url ?? `${origin}/`);
}

function render(servers: SavedServer[]): void {
    list.replaceChildren(...servers.map((server) => {
        const li = document.createElement('li');
        const openButton = document.createElement('button');
        openButton.type = 'button';
        openButton.className = 'open';
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = server.name;
        const origin = document.createElement('span');
        origin.className = 'origin';
        origin.textContent = server.origin;
        openButton.append(name, origin);
        openButton.addEventListener('click', () => void open(server.origin));

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'remove';
        remove.textContent = 'Remove';
        remove.setAttribute('aria-label', `Remove ${server.name}`);
        remove.addEventListener('click', async () => {
            if (changing || leaving) return;
            if (!window.confirm(`Remove ${server.name} (${server.origin})? Push notifications from it stop until you add it again and sign in.`)) return;
            changing = true;
            try {
                await removeServer(server, {
                    store,
                    kv: Preferences,
                    deleteRelayHandle: (handle) => deleteRelayHandle(http, RELAY_URL, handle),
                    // On Android native then re-scopes the bridge on a blank page and reloads the picker.
                    serversChanged: () => AgoraShell.serversChanged(),
                    shown: (servers, text) => {
                        render(servers);
                        announce(text);
                    },
                });
            } catch (err) {
                console.warn('[picker] removing a server failed', errorDetail(err));
            } finally {
                changing = false;
            }
        });
        li.append(openButton, remove);
        return li;
    }));
    empty.hidden = servers.length > 0;
}

form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (changing || leaving) return;
    const origin = normalizeOrigin(input.value);
    if (!origin) {
        setStatus(MESSAGES.notHttps, true);
        return;
    }
    addButton.disabled = true;
    setStatus(`Checking ${origin}...`);
    let name: string;
    try {
        ({ name } = await probeInstance(origin, http));
    } catch (err) {
        console.warn('[picker] probe failed', origin, errorDetail(err));
        setStatus(probeFailureMessage(err), true);
        addButton.disabled = false;
        return;
    }
    changing = true;
    try {
        render(await store.add({ origin, name }));
        input.value = '';
        announce(`Added ${name}.`);
        await AgoraShell.serversChanged();
    } catch (err) {
        console.warn('[picker] saving a server failed', origin, errorDetail(err));
        setStatus(MESSAGES.saveFailed, true);
    } finally {
        changing = false;
        addButton.disabled = false;
    }
});

async function openDeepLink(data: PushData | null): Promise<boolean> {
    if (!data || leaving || changing) return false;
    const servers = await store.origins();
    const withHandles = new Set<string>();
    for (const origin of servers) {
        if ((await Preferences.get({ key: handleKey(origin) })).value) withHandles.add(origin);
    }
    const target = resolveDeepLink(data, servers, (o) => withHandles.has(o));
    if (!target) return false;
    await open(data.instance as string, target);
    return true;
}

async function start(): Promise<void> {
    const servers = await store.list();
    render(servers);
    // "Added X." / "Removed X." from before the reload that serversChanged caused.
    const carried = takeFlash(flash);
    if (carried) setStatus(carried);
    // The shell came back here because a saved server's page could not load.
    const unreachable = readUnreachable(window.location.hash);
    if (unreachable) {
        history.replaceState(null, '', window.location.pathname);
        const server = servers.find((s) => s.origin === unreachable);
        if (server) setStatus(unreachableServerMessage(server.name), true);
    }

    // A notification tapped while an instance page was open, handed over in the fragment.
    const handedOver = readPickerOpen(window.location.hash);
    if (handedOver) {
        history.replaceState(null, '', window.location.pathname);
        if (await openDeepLink(handedOver.data)) return;
        // Not a link this app opens: go back to the server the user was on.
        const back = returnUrl(handedOver.from, servers.map((s) => s.origin));
        if (back) {
            leaving = true;
            window.location.replace(back);
            return;
        }
    }

    // A notification that launched the app. The plugin keeps the event until a listener takes it.
    let tapped = false;
    await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        tapped = true;
        void openDeepLink(pushData(action));
    });

    const { autoOpen } = await AgoraShell.getLaunchState();
    // Give a retained tap event a moment to arrive before opening the last server.
    await new Promise((r) => setTimeout(r, 300));
    if (!autoOpen || tapped || leaving || unreachable) return;
    const last = await store.lastUsed();
    const target = servers.find((s) => s.origin === last) ?? (servers.length === 1 ? servers[0] : undefined);
    if (target) await open(target.origin);
}

/** The shell could not scope the bridge (old Android WebView): say what to update, and offer nothing that needs native code. */
function showWebViewTooOld(): void {
    list.hidden = true;
    empty.hidden = true;
    form.hidden = true;
    const lead = document.querySelector('.lead');
    if (lead) lead.textContent = WEBVIEW_TOO_OLD;
}

if (nativeBridgeMissing(window as unknown as { WEBVIEW_SERVER_URL?: unknown }, Capacitor.isNativePlatform())) {
    showWebViewTooOld();
} else {
    void start();
}
