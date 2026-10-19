import { beforeEach, expect, test, vi } from 'vitest';

// Each test loads the store fresh, as a page load does, with nothing remembered
// in localStorage: another origin, cleared storage, or a new browser profile.
const values = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
});
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

const user = { id: 'U1', username: 'eryk' };

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function loadStore() {
  vi.resetModules();
  const { useAuthStore } = await import('./authStore');
  return useAuthStore;
}

async function settled(store: Awaited<ReturnType<typeof loadStore>>) {
  await vi.waitFor(() => expect(store.getState().status).not.toBe('checking'));
}

beforeEach(() => {
  values.clear();
  fetchMock.mockReset();
});

test('no remembered user and a valid session cookie restores the session', async () => {
  let answer!: (res: Response) => void;
  fetchMock.mockReturnValue(new Promise(resolve => { answer = resolve; }));
  const store = await loadStore();
  // Neither the login page nor the app until the server answers
  expect(store.getState().status).toBe('checking');
  answer(json(200, { user }));
  await settled(store);
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls[0][0]).toBe('/auth/session');
  expect(store.getState()).toMatchObject({ status: 'authenticated', user });
  expect(JSON.parse(values.get('agora_user')!)).toEqual(user);

  // AuthGuard's background check does not ask a second time
  await store.getState().verifySession();
  expect(fetchMock).toHaveBeenCalledOnce();
});

test('no remembered user and no session cookie shows the login page', async () => {
  fetchMock.mockResolvedValue(json(401, { error: 'unauthorized' }));
  const store = await loadStore();
  await settled(store);
  expect(store.getState()).toMatchObject({ status: 'idle', user: null });
});

test('a network error while checking falls back to the login page', async () => {
  fetchMock.mockRejectedValue(new TypeError('fetch failed'));
  const store = await loadStore();
  await settled(store);
  expect(store.getState().status).toBe('idle');
});

test('a remembered user renders at once without waiting on the server', async () => {
  values.set('agora_user', JSON.stringify(user));
  const store = await loadStore();
  expect(store.getState()).toMatchObject({ status: 'authenticated', user });
  expect(fetchMock).not.toHaveBeenCalled();
});

test('a retired legacy token is revoked and the user signs in again, without a session check', async () => {
  values.set('agora_token', 'legacy-token');
  values.set('agora_user', JSON.stringify(user));
  fetchMock.mockResolvedValue(json(200, {}));
  const store = await loadStore();
  expect(store.getState().status).toBe('idle');
  expect([...values.keys()]).toEqual([]);
  expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/auth/logout', {
    method: 'POST', headers: { Authorization: 'Bearer legacy-token' },
  });
});
