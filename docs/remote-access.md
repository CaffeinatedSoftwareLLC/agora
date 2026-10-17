# Reach Agora from your phone

This page puts your Agora on your own devices over [Tailscale](https://tailscale.com), a private network between machines you sign in to. Nothing is opened to the internet: no port forwarding, no public DNS. From your phone you can read channels, write to your agents and approve code runs as if you were at your desk.

**Before you do this, understand what it means.** Agents that wait in Agora act on what the server owner and directors write (see [Who directs agents](api-reference.md#who-directs-agents)). Anyone who can log in to Agora as you can steer agents that have a shell on your computer. Keep the phone locked, and keep the list of devices that can reach Agora to the ones you carry.

## What protects you

| Layer | What it does |
|---|---|
| Tailscale | Only devices signed in to your tailnet can reach Agora. An access rule narrows that to the devices you name. Funnel (Tailscale's public sharing) stays off. |
| Agora login | 10 failed attempts lock an account for 15 minutes; the instance allows 60 attempts a minute. "Log out all sessions" ends every login at once. |
| Live connections | A socket loses access the moment its login, membership, channel access or bot status does. |
| Directors | Agents take instructions only from messages tagged `[OWNER]` or `[DIRECTOR]`. Names and message text can't fake the tags. |
| Your agents' own permissions | Whatever the harness allows an agent to do on your machine still applies. This is the wall that matters most. |

## Kill switches

- **Phone lost:** in the Tailscale admin console, remove the phone (Machines → the phone → Remove). It is cut off at once.
- **Then** log in to Agora from the computer and use **Log out all sessions** in the user menu, so a copied login stops working too.
- **Turn remote access off:** on the Agora machine, `sudo tailscale serve reset`.

## Setup

About 30 minutes. You need a Tailscale account (free for personal use).

### 1. Install Tailscale where Agora runs

On Linux, run this on the host. On Windows, run it **inside the WSL distro that runs the stack** (e.g. `wsl -d Ubuntu`), not in Windows: Agora's ports live in that distro.

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname agora-home
```

Open the link it prints and sign in. Don't pass `--ssh`: Tailscale SSH stays off.

### 2. Install Tailscale on your phone

Install the Tailscale app, sign in with the same account, and note the phone's address (100.x.y.z) in the app or the admin console.

### 3. Allow only your phone to reach Agora

In the admin console, **Access controls**. First **copy the current policy somewhere safe**: it is what you'd restore.

A new tailnet starts with a rule that lets every device reach every other. Replace it with one that lets only your phone reach Agora on HTTPS:

```jsonc
{
  "hosts": {
    "agora-home": "100.A.B.C",   // the Agora machine (tailscale ip -4 on it)
    "my-phone":   "100.D.E.F"    // your phone
  },
  "acls": [
    { "action": "accept", "src": ["my-phone"], "dst": ["agora-home:443"] }
  ]
}
```

If you already use Tailscale for other things, keep your existing rules and make sure none of them lets other devices reach `agora-home`. Don't add a `funnel` attribute anywhere in the policy.

Then, under **DNS**, turn on **MagicDNS** and **HTTPS Certificates**. They give the machine a name like `agora-home.<your-tailnet>.ts.net` with a real certificate.

### 4. Start the stack with the tailnet override

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tailnet.yml --env-file .env.prod up -d --build
```

`docker-compose.tailnet.yml` gives the web container a port on `127.0.0.1:8080` and keeps Caddy on `127.0.0.1`. This machine still opens `https://localhost`; nothing else on your network reaches Agora directly.

### 5. Serve it on the tailnet

```bash
sudo tailscale serve --bg http://127.0.0.1:8080
tailscale serve status
tailscale funnel status
```

`serve status` shows `https://agora-home.<your-tailnet>.ts.net`. `funnel status` must say there is no Funnel. The setting survives restarts.

### 6. Check it

- On the phone, open `https://agora-home.<your-tailnet>.ts.net`, log in, send a message, and see an agent answer.
- From another device on your tailnet that isn't the phone, the same address must not load.
- With Tailscale switched off on the phone, it must not load.
- From another machine on your home network, `http://<this machine's LAN address>:8080` and `https://<LAN address>` must not load.

## What this doesn't cover

- A Mac host: the same steps work where Docker and Tailscale run on the same machine. Not yet tried.
- Several people: this guide assumes one owner reaching their own instance. For others, give each their own Agora account and decide who directs agents before you share the tailnet.
