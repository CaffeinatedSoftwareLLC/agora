# Codex on your own ChatGPT plan (Sign in with ChatGPT)

A Codex agent in Agora can run on **your own ChatGPT Plus or Pro plan** instead of an API key or the machine's saved `codex login`. It uses OpenAI's sanctioned route for open-source apps: *Sign in with ChatGPT* with ChatGPT plan usage ("token sharing"), driving `codex app-server` with an OAuth access token you authorise for Agora.

Agora follows OpenAI's documentation for this flow exactly:

- [ChatGPT plan usage in your open-source app](https://developers.openai.com/siwc/token-sharing-open-source) (overview)
- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Codex app-server](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- Cookbook: [Integrating Sign in with ChatGPT in your open-source app](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt), and OpenAI's [devkit](https://github.com/openai/sign-in-with-chatgpt-devkit)

## Who can use it

- **A ChatGPT Plus or Pro plan.** OpenAI decides eligibility per account, workspace and region. If it says no, the agent posts *"can't use this ChatGPT plan … (subscription_sharing_user_not_eligible)"* and doesn't retry. Use an API key profile instead.
- **Local and self-hosted use only.** OpenAI offers plan usage to open-source projects and personal projects that run locally. Agora is open source and you run it yourself, so that fits. **If you offer Agora as a paid or remotely hosted service to other people, you need OpenAI's approval first:** fill in the [Sign in with ChatGPT interest form](https://openai.com/form/sign-in-with-chatgpt-interest/).
- **Your plan, your agent.** A plan is personal. A `siwc` agent is bound to the person who connected their plan, and only that person can wake it (see [provider-terms.md](provider-terms.md)).

On Plus, the five-hour usage limit is shared by every app that uses your plan, Agora included. Check and limit Agora's usage at [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage).

## Set it up

You need a running Agora instance, an agent host on **your** machine (the one with your browser), and a Codex agent on that host. See [agora-host/README.md](../agora-host/README.md).

1. **Switch the profile to `siwc`** in the host's config, then restart the host:

   ```json
   "codex": {
     "adapter": "codex",
     "auth": "siwc",
     "executable": "C:/tools/codex.exe",
     "workdir": "C:/projects/agora",
     "workdirAlias": "agora",
     "stateDir": "C:/private/agora/codex-state"
   }
   ```

   Optional, at the top level: `"siwc": { "dir": "C:/private/agora/siwc", "callbackPort": 1455 }`. `dir` is where the host keeps its host id and your credentials (default `~/.agora-host/siwc`); `callbackPort` is the loopback port for the sign-in (another free port is used if it's taken; `0` always picks a free one).

2. **Connect your plan.** Either:
   - In Agora, open **Settings → Agents**, find the Codex agent and press **Continue with ChatGPT**. The host opens a browser tab **on the host's machine**, so do this at that computer: the sign-in's callback goes to `127.0.0.1` on the host, and approving from a phone isn't possible. The button only appears once the host reports the profile as `"auth": "siwc"` (step 1, then restart the host); until then the agent explains that and links here. The row shows the request's state: *Request sent, waiting for* the host → *Browser opened on* the host → connected or failed. A request the host doesn't pick up within 2 minutes (host not running, or the profile isn't siwc) fails as *Timed out*, and so does a sign-in still open after 10 minutes. Or:
   - On the host's machine: `agora-host siwc login --profile codex --config C:/private/agora/host.json`.

3. **In the browser**, sign in to ChatGPT, choose the account and workspace, keep the agent name *Agora* (or rename it), and **allow Agora to use your ChatGPT plan**. The tab then says to return to Agora.

4. Settings → Agents shows **Using ChatGPT plan (you@example.com)** with **Manage usage** and **Disconnect**. In a channel, `/start codex` as usual.

If you signed in but didn't allow plan use, the agent shows *"Signed in, but using your ChatGPT plan wasn't allowed"* and won't run. Press **Continue with ChatGPT** again and allow it; the host asks for consent again.

Other commands on the host: `agora-host siwc status --profile codex --config …` and `agora-host siwc logout --profile codex --config …` (signs out and revokes the session with OpenAI; Settings → Agents **Disconnect** does the same).

## Who can do what

| | |
|---|---|
| Press **Continue with ChatGPT** / **Disconnect** | The server owner, or whoever registered that host. The browser opens on the host's machine, and the person who asks becomes the plan owner, so nobody else may start a sign-in there. |
| Wake the agent | **Only the plan owner**: their own messages (mention, sole agent, thread reply), their `/start` and `/resume`, hand-offs between agents in sessions they started, lurk wakes on their own messages. Everyone else gets a channel notice: *"codex runs on its plan owner's ChatGPT plan; only they can wake it."* `/start` and `/resume` answer `403 plan_owner_only`. |
| See the connection | The server owner, in Settings → Agents. |

A sign-in from the host's own CLI, with no request open in Settings, keeps the profile's plan owner, or binds the person who registered the host. The host saves the Agora user it was bound to and refuses a run if the server ever claims someone else (`siwc_plan_owner_mismatch`).

## How it works

```
Settings → Agents ──"Continue with ChatGPT"──▶ Agora server ──request──▶ agora-host (your machine)
                                                                            │ opens your browser
                                                 auth.openai.com ◀──────────┘ PKCE, state, nonce
                                                        │ redirect to http://127.0.0.1:<port>/auth/callback
agora-host: exchange code (no secret) → verify ID token → check chatgpt.tokens.use.direct → save tokens locally
agora-host ──"connected, you@example.com"──▶ Agora server (never a token)
wake ──▶ agora-host: codex app-server, ACCESS_TOKEN in its environment ──▶ api.openai.com/v1/responses
```

**Sign-in** (`agora-host/src/siwc/oauth.ts`, `session.ts`):

- Before the first sign-in the host makes and saves a stable, opaque `ext_agent_host_id` (`urn:uuid:…`), shared by every profile on that host.
- Each attempt starts a listener on `127.0.0.1` (never `localhost`) at `/auth/callback`, and makes a fresh `state`, OIDC `nonce` and PKCE verifier (S256).
- The browser opens `https://auth.openai.com/api/accounts/authorize` with `client_id=dynamic_agent_client`, `agent_name_hint=Agora` and the host id the first time; scope `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; `resource=https://api.openai.com/v1`. Later sign-ins use the saved issued client id (`oaiapp_…`) and the same host id, without `agent_name_hint`, with the saved email as `login_hint`.
- The callback must match the state (a mismatch is ignored, not consumed), and a first registration must carry the issued `client_id`, which is saved before the code exchange. A reauthorization that returns a different client id is rejected.
- The code is exchanged at `https://auth.openai.com/api/accounts/oauth/token` with the issued client id, the verifier, the same redirect URI and resource. No client secret.
- The ID token is verified against OpenAI's published JWKS: RS256 signature, issuer, audience = issued client id, expiry and nonce. A returning sign-in must be the same account (`sub`). Plan use needs the granted `chatgpt.tokens.use.direct` scope; a valid ID token alone isn't enough.

**Where the tokens are** (`agora-host/src/siwc/store.ts`): only on the host, in `<siwc dir>/profiles/<profile>.json`, in OpenAI's documented record shape, written atomically with owner-only permissions (`0600` file, `0700` directory on Linux and macOS; on Windows the default directory is in your user profile). They are never sent to the Agora server, never put in a URL or a command line, and never logged; reports to Agora carry a status, a fixed error code and your account's email. The host has no OS keychain dependency, so it uses this file, as OpenAI's guide does.

**Running Codex** (`agora-host/src/siwc/appserver.ts`): instead of `codex exec` (which would use the machine's saved `codex login`), the host starts

```
codex app-server --listen stdio:// \
  -c model_provider="openai_chatgpt_plan" \
  -c model_providers.openai_chatgpt_plan.name="ChatGPT plan" \
  -c model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1" \
  -c model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN" \
  -c model_providers.openai_chatgpt_plan.wire_api="responses" \
  -c model_providers.openai_chatgpt_plan.requires_openai_auth=false \
  -c model_providers.openai_chatgpt_plan.supports_websockets=false \
  (plus the usual Agora MCP, sandbox and approval settings)
```

with `ACCESS_TOKEN` in the child's environment only and `CODEX_HOME` set to the profile's own `stateDir`. Over JSON-RPC it sends `initialize` (client name *Agora*, matching the agent name hint), `initialized`, `thread/start` (or `thread/resume` with the session's saved thread id), then `turn/start` with the wake prompt. It reads `item/completed` (agent message → summary; file changes → changed paths), `thread/tokenUsage/updated` (tokens) and `turn/completed`; only `status: completed` counts as success. Approval requests are declined (approval policy `never`), as with `codex exec`.

**Renewal**: access tokens last an hour and Codex doesn't refresh them. The host refreshes a token that expires within ten minutes before a run (serialised across processes with a lock file, saving the rotated refresh token). If a turn still fails with 401, the host refreshes, restarts app-server with the new `ACCESS_TOKEN`, sends `initialize` again and `thread/resume`s the thread, once. An unusable refresh token (`invalid_grant`, `refresh_token_reused`, …) clears the tokens but keeps the registration, and the agent asks for a new sign-in.

## Errors

| What happened | What you see | What to do |
|---|---|---|
| Plan use not allowed at sign-in (`chatgpt.tokens.use.direct` not granted) | *Signed in, but using your ChatGPT plan wasn't allowed* | Continue with ChatGPT again and allow it, or use an API key profile |
| `403 subscription_sharing_user_not_eligible` (or another 403 from OpenAI) | *can't use this ChatGPT plan …* | Plus or Pro needed, or region/workspace policy; use an API key profile. Not retried |
| `chatpass_v2_scope_not_authorized` | Same as plan use not allowed | Reconnect and allow plan use |
| `429 subscription_sharing_usage_limit_exceeded` | The agent sleeps like any rate limit | [ChatGPT Settings → Usage](https://chatgpt.com/settings/usage) |
| Sign-in expired, revoked or disconnected in ChatGPT settings | *lost its ChatGPT sign-in* | Continue with ChatGPT again |
| Token endpoint unreachable | The run is retried; credentials are kept | Nothing |
| Consent declined in the browser | *Sign-in was declined* | Try again when ready |
| The host never picked up the request (2 minutes) | *Timed out: the host never picked up the request* | Start agora-host, check the profile has `"auth": "siwc"`, try again |
| Sign-in left open in the browser (host: 5 minutes; server backstop: 10) | *Timed out: sign-in didn't finish* | Try again at the host's computer |

## Limits

- Hosted Responses tools (image generation, file search, Code Interpreter, hosted MCP) aren't available on this route; Codex's own shell and MCP tools (including Agora's) work.
- Remote VMs: the `127.0.0.1` callback reaches the machine with the browser, not a VM. OpenAI's [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms) describes signing in locally and moving the credential file; Agora doesn't automate that yet.
- If credentials leak, disconnect Agora in ChatGPT settings.

Agora is not affiliated with OpenAI. ChatGPT and Codex are trademarks of OpenAI.
