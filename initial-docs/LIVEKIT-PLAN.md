# Agora + LiveKit -- Voice, Video & Screen Share Implementation Plan

> Reference document for Claude Code sessions. Read DECISIONS.md first, then this.
>
> Last updated: 2026-02-17

---

## Overview

LiveKit is an open-source (Apache 2.0) WebRTC SFU written in Go. It handles all the hard parts -- STUN/TURN, NAT traversal, simulcast, adaptive bitrate, screen sharing, noise cancellation -- and exposes clean SDKs for React and Node.js. We self-host it as a Docker service alongside the existing Agora stack.

**What we're building:** Discord-style voice channels with video toggle and screen sharing, plus 1:1 and group voice/video calling in DMs.

---

## Architecture

```
+-----------------------------------------------------------+
|  Agora Client (React)                                     |
|  +------------------------------------------------------+ |
|  |  @livekit/components-react                           | |
|  |  LiveKitRoom -> custom UI (NOT prefabs)              | |
|  |  Hooks: useTracks, useParticipant, etc.              | |
|  +---------------------+--------------------------------+ |
|                         | WebSocket + WebRTC               |
+-------------------------+----------------------------------+
                          |
                          v
+-----------------------------------------------------------+
|  LiveKit Server (Docker: livekit/livekit-server)          |
|  Port 7880 (WS signaling) + 7881 (TCP) + 50000-60000     |
|  (UDP media). Uses Redis for state.                       |
+-----------------------------------------------------------+
                          ^
                          | Token generation via livekit-server-sdk
                          |
+-----------------------------------------------------------+
|  Agora Backend (Fastify)                                  |
|  POST /api/voice/token -- generates JWT access token      |
|  POST /api/voice/kick -- admin removes participant        |
|  Webhook receiver for room events                         |
|  Uses: livekit-server-sdk (npm)                           |
+-----------------------------------------------------------+
```

**Key principle:** LiveKit handles ALL media. Agora handles auth, permissions, and room lifecycle. They communicate via JWT tokens and webhooks.

---

## Packages to Install

### Backend (Fastify)
```bash
npm install livekit-server-sdk
```

### Frontend (React)
```bash
npm install livekit-client @livekit/components-react @livekit/components-styles
```

---

## Docker Compose -- Deployment Topologies

LiveKit supports two Docker networking modes. Choose based on your environment.

### Topology A: Host Networking (Linux production -- recommended)

Best performance. LiveKit handles UDP ports directly with no NAT overhead.

```yaml
# Add to existing docker-compose.yml
livekit:
  image: livekit/livekit-server:latest
  command: --config /etc/livekit.yaml
  restart: unless-stopped
  network_mode: "host"
  volumes:
    - ./livekit.yaml:/etc/livekit.yaml
  depends_on:
    redis:
      condition: service_healthy
```

```yaml
# livekit.yaml (host networking)
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 60000
  use_external_ip: true
redis:
  address: localhost:6379
keys:
  devkey: secret  # generate real keys for production: openssl rand -hex 32
logging:
  level: info
```

**Prerequisite:** With host networking, LiveKit reaches Redis via `localhost:6379`. This only works if your Redis service is ALSO host-networked, or publishes port 6379 to the host. If your existing Agora Redis runs on the default bridge network without host port mapping, LiveKit won't reach it. Either:
- Add `network_mode: "host"` to your Redis service too, OR
- Add `ports: ["6379:6379"]` to your Redis service, OR
- Use the Docker bridge gateway IP instead of `localhost` (commonly `172.17.0.1`, but this varies with rootless Docker, custom bridges, and Docker Desktop VMs -- verify yours with `docker network inspect bridge --format "{{range .IPAM.Config}}{{.Gateway}}{{end}}"` on any platform, or `docker network inspect bridge | grep Gateway` on Unix shells)

### Topology B: Port-Mapped (Mac/Windows dev, or Linux without host networking)

Docker Desktop on Mac/Windows has historically lacked `network_mode: "host"` support, though recent versions have added it behind feature flags/settings. If host networking is unavailable or unreliable on your platform, use explicit port mapping with `node_ip` configured so LiveKit advertises the correct address to WebRTC clients.

```yaml
livekit:
  image: livekit/livekit-server:latest
  command: --config /etc/livekit.yaml --dev
  restart: unless-stopped
  ports:
    - "7880:7880"   # signaling
    - "7881:7881"   # TCP fallback
    - "50000-50100:50000-50100/udp"  # media (narrow range for dev)
  volumes:
    - ./livekit.yaml:/etc/livekit.yaml
  depends_on:
    redis:
      condition: service_healthy
```

```yaml
# livekit.yaml (port-mapped)
port: 7880
rtc:
  tcp_port: 7881
  port_range_start: 50000
  port_range_end: 50100  # narrow range for dev -- expand for production
  use_external_ip: false
  node_ip: 127.0.0.1  # set to machine's LAN IP for multi-device testing
redis:
  address: redis:6379  # Docker service name, NOT localhost
keys:
  devkey: secret
logging:
  level: info
```

**Topology B limitations:** The narrow UDP range (100 ports) supports ~50 simultaneous media streams -- plenty for development but not production. On a Linux VPS with port mapping, expand to `50000-60000` and set `node_ip` to the server's public IP.

### Production Additions (either topology)

```yaml
# Add to livekit.yaml for production
keys:
  YOUR_API_KEY: YOUR_API_SECRET  # openssl rand -hex 32 for each
turn:
  enabled: true
  domain: turn.yourdomain.com
  tls_port: 5349
  udp_port: 443  # QUIC/HTTP3 -- passes most corporate firewalls
```

### Environment Variables (add to Agora .env)
```
LIVEKIT_URL=ws://localhost:7880        # wss:// for production
LIVEKIT_API_KEY=devkey                 # from livekit.yaml keys
LIVEKIT_API_SECRET=secret              # from livekit.yaml keys
```

---

## Firewall / Port Requirements

| Port | Protocol | Purpose |
|------|----------|---------|
| 7880 | TCP | WebSocket signaling |
| 7881 | TCP | WebRTC over TCP fallback |
| 50000-60000 | UDP | WebRTC media (production -- narrow for dev) |
| 443 | UDP | TURN/UDP (production, recommended for firewall traversal) |
| 5349 | TCP | TURN/TLS (production, fallback for strict firewalls) |

**Host networking vs port mapping:** Host networking avoids NAT overhead and is recommended for Linux production. Port mapping works when `node_ip` and the UDP port range are configured correctly -- it does NOT "break" WebRTC, but requires explicit configuration that host networking handles automatically.

**ngrok limitation:** ngrok tunnels TCP only. Voice/video will NOT work over ngrok unless LiveKit's built-in TURN server is enabled to relay media over TCP/TLS. For remote multi-user testing, a VPS with a public IP is the simplest path.

---

## Backend Implementation

### 1. Token Generation Endpoint

```typescript
// routes/voice.ts
import { AccessToken, TrackSource } from 'livekit-server-sdk';

// POST /api/voice/token
// Body: { channelId: string }
// Returns: { token: string, url: string }
async function generateVoiceToken(request, reply) {
  const { channelId } = request.body;
  const user = request.user; // from existing auth middleware (ensure this route uses the same preHandler as other protected routes)

  // Check user has permission to join this channel
  const perms = await computePermissions(user.id, channelId);
  if (!(perms & CONNECT_VOICE)) {
    return reply.code(403).send({ error: 'Missing CONNECT_VOICE permission' });
  }

  // Room name = channel ID (1:1 mapping)
  const roomName = `channel-${channelId}`;

  const at = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    {
      identity: user.id,
      name: user.display_name,
      ttl: '4h',
    }
  );

  // Map Agora permission bitmask to LiveKit token grants
  const canSpeak = !!(perms & SPEAK);
  const canVideo = !!(perms & USE_VIDEO);
  const canScreenShare = !!(perms & SCREEN_SHARE);

  // Build source-level publish restrictions using SDK enum (not raw strings)
  const canPublishSources: TrackSource[] = [];
  if (canSpeak) canPublishSources.push(TrackSource.MICROPHONE);
  if (canVideo) canPublishSources.push(TrackSource.CAMERA);
  if (canScreenShare) {
    canPublishSources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  }

  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: canPublishSources.length > 0,
    canPublishSources,    // server-enforced: user can only publish these track types
    canSubscribe: true,   // all connected users can hear/see others
    canPublishData: true, // data messages (e.g. raise hand, reactions)
  });

  const token = await at.toJwt();

  reply.send({
    token,
    url: process.env.LIVEKIT_URL,
  });
}
```

### 2. Admin Controls (Server-Side)

```typescript
// routes/voice-admin.ts
import { RoomServiceClient } from 'livekit-server-sdk';

const svc = new RoomServiceClient(
  process.env.LIVEKIT_URL!.replace('ws', 'http'), // HTTP for API
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

// POST /api/voice/kick -- remove a participant
async function kickParticipant(request, reply) {
  const { channelId, userId } = request.body;
  // verify requesting user has MOVE_MEMBERS permission (see permission table)
  await svc.removeParticipant(`channel-${channelId}`, userId);
  reply.send({ success: true });
}

// POST /api/voice/mute -- server-side mute a participant
async function muteParticipant(request, reply) {
  const { channelId, userId } = request.body;
  // verify requesting user has MUTE_MEMBERS permission (see permission table)
  await svc.updateParticipant(`channel-${channelId}`, userId, undefined, {
    canPublish: false,
  });
  reply.send({ success: true });
}

// GET /api/voice/participants/:channelId -- list who's in the channel
async function listParticipants(request, reply) {
  const { channelId } = request.params;
  const participants = await svc.listParticipants(`channel-${channelId}`);
  reply.send({ participants });
}
```

### 3. Webhook Receiver (Room Events)

LiveKit can POST events when participants join/leave, rooms are created/destroyed. Use this to update presence in the Agora UI.

**Prerequisite:** Fastify does not expose raw request bodies by default. You must enable it for the webhook route so signature verification works:

```typescript
// In your Fastify app setup:
// Option A: Enable globally (simplest, but adds overhead to all routes)
const app = fastify({ rawBody: true });

// Option B (RECOMMENDED): Enable per-route via fastify-raw-body plugin
// npm install fastify-raw-body
import rawBody from 'fastify-raw-body';
app.register(rawBody, {
  field: 'rawBody',
  global: false,    // no overhead on other routes
  encoding: 'utf8',
  runFirst: true,
  routes: ['/api/webhooks/livekit'],  // whitelist only the webhook route
});
```

```typescript
// routes/voice-webhooks.ts
import { WebhookReceiver } from 'livekit-server-sdk';

const receiver = new WebhookReceiver(
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET
);

// POST /api/webhooks/livekit
// Content-Type: application/webhook+json
async function handleLiveKitWebhook(request, reply) {
  const event = await receiver.receive(
    request.rawBody, // requires rawBody enabled -- see prerequisite above
    request.headers['authorization']
  );

  switch (event.event) {
    case 'participant_joined':
      // Broadcast via Socket.IO: user joined voice channel
      io.to(`channel-${event.room.name}`).emit('voice:participant_joined', {
        userId: event.participant.identity,
        channelId: event.room.name.replace('channel-', ''),
      });
      break;

    case 'participant_left':
      // Broadcast via Socket.IO: user left voice channel
      io.to(`channel-${event.room.name}`).emit('voice:participant_left', {
        userId: event.participant.identity,
        channelId: event.room.name.replace('channel-', ''),
      });
      break;

    case 'room_finished':
      // Room is empty, clean up any state
      break;
  }

  reply.send({ ok: true });
}
```

**livekit.yaml webhook config:**
```yaml
webhook:
  urls:
    # This URL must be reachable FROM the LiveKit container.
    # Host networking (Topology A): localhost works since LiveKit shares the host network.
    # Port-mapped (Topology B): use the Docker service name (e.g., http://api:3000/...)
    #   or host.docker.internal on Docker Desktop.
    # Production: use the internal service URL or ingress URL.
    - http://localhost:3000/api/webhooks/livekit  # <-- change per environment
  api_key: devkey
```

**Note:** LiveKit reads this YAML directly -- it does NOT support shell-style env interpolation (`${VAR}`). If you need per-environment webhook URLs, either generate `livekit.yaml` at deploy time (e.g., via envsubst or a template script), or maintain separate config files per environment.

---

## Frontend Implementation

### Strategy: Custom UI, Not Prefabs

LiveKit ships prefab components (`<VideoConference />`, `<AudioConference />`, `<ControlBar />`) but they look generic and can't match the Aegean/Terracotta themes. Instead, use **hooks + low-level components** for full control.

Use prefabs for: nothing (build custom)
Use from `@livekit/components-react`:
- `<LiveKitRoom />` -- room connection wrapper
- `<RoomAudioRenderer />` -- renders all subscribed audio (REQUIRED)
- Hooks: `useTracks`, `useParticipant`, `useLocalParticipant`, `useRoomContext`
- `<VideoTrack />`, `<AudioTrack />` -- render individual tracks

### Component Hierarchy

```
<VoiceChannelProvider channelId={id}>
  |-- <VoiceChannelPanel />          <- sidebar showing who's connected
  |   |-- <VoiceParticipant />       <- per-user row (avatar, name, mute icon, speaking indicator)
  |   +-- <VoiceConnectionBar />     <- "Connected to #general" + disconnect button
  |
  |-- <VoiceControlBar />            <- bottom bar when in voice
  |   |-- <MicToggle />              <- mute/unmute microphone
  |   |-- <DeafenToggle />           <- deafen (mute all incoming audio)
  |   |-- <CameraToggle />           <- toggle camera on/off
  |   |-- <ScreenShareToggle />      <- start/stop screen share
  |   |-- <DeviceSelector />         <- pick mic/speaker/camera
  |   +-- <DisconnectButton />       <- leave voice channel
  |
  +-- <VideoGrid />                  <- shown when someone has camera/screenshare on
      |-- <VideoTile />              <- individual video feed
      +-- <ScreenShareView />        <- focused screen share layout
```

### Core Implementation

```tsx
// components/voice/VoiceChannelProvider.tsx
import { LiveKitRoom, RoomAudioRenderer } from '@livekit/components-react';
import { useState, useEffect } from 'react';

export function VoiceChannelProvider({ channelId, children }) {
  const [token, setToken] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    // Fetch token from Agora backend
    fetch(`/api/voice/token`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId }),
    })
      .then(res => res.json())
      .then(data => {
        setToken(data.token);
        setUrl(data.url);
      });
  }, [channelId]);

  if (!token || !url) return <VoiceConnecting />;

  return (
    <LiveKitRoom
      token={token}
      serverUrl={url}
      connect={true}
      audio={true}   // join with mic on by default (or false for push-to-talk)
      video={false}   // camera off by default
      options={{
        adaptiveStream: true,
        dynacast: true, // optimize bandwidth
      }}
    >
      <RoomAudioRenderer />  {/* CRITICAL: renders all remote audio */}
      {children}
    </LiveKitRoom>
  );
}
```

**Note on data fetching:** The example above uses raw `useEffect` + `fetch` for simplicity. If Agora already uses TanStack Query (React Query) elsewhere, use it here too for consistency -- it handles loading states, error retry, and request deduping better than manual `useEffect` patterns.

### Media Controls

```tsx
// components/voice/VoiceControlBar.tsx
import { useState, useEffect, useRef } from 'react';
import {
  useLocalParticipant,
  useRoomContext,
} from '@livekit/components-react';
import { Track, RoomEvent } from 'livekit-client';

export function VoiceControlBar() {
  const room = useRoomContext();
  const { localParticipant } = useLocalParticipant();
  const [isDeafened, setIsDeafened] = useState(false);

  // Microphone toggle
  const toggleMic = async () => {
    await localParticipant.setMicrophoneEnabled(
      !localParticipant.isMicrophoneEnabled
    );
  };

  // Camera toggle
  const toggleCamera = async () => {
    await localParticipant.setCameraEnabled(
      !localParticipant.isCameraEnabled
    );
  };

  // Screen share toggle
  const toggleScreenShare = async () => {
    await localParticipant.setScreenShareEnabled(
      !localParticipant.isScreenShareEnabled
    );
  };

  // Deafen -- mutes all incoming audio locally (including future participants)
  // Uses a ref to persist state and a room event listener to catch new tracks
  const isDeafenedRef = useRef(false);
  const toggleDeafen = () => {
    const newState = !isDeafened;
    setIsDeafened(newState);
    isDeafenedRef.current = newState;

    // Mute/unmute all currently subscribed remote audio tracks
    room.remoteParticipants.forEach((p) => {
      p.audioTrackPublications.forEach((pub) => {
        if (pub.track) {
          pub.track.setEnabled(!newState);
        }
      });
    });

    // Also mute mic when deafening (Discord behavior)
    if (newState && localParticipant.isMicrophoneEnabled) {
      localParticipant.setMicrophoneEnabled(false);
    }
  };

  // Handle new tracks that arrive AFTER deafen was toggled
  useEffect(() => {
    const handleTrackSubscribed = (track) => {
      if (isDeafenedRef.current && track.kind === Track.Kind.Audio) {
        track.setEnabled(false);
      }
    };
    room.on(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    return () => {
      room.off(RoomEvent.TrackSubscribed, handleTrackSubscribed);
    };
  }, [room]);

  // Disconnect from voice
  const disconnect = () => {
    room.disconnect();
  };

  // Device selection
  const switchMicrophone = async (deviceId: string) => {
    await room.switchActiveDevice('audioinput', deviceId);
  };
  const switchSpeaker = async (deviceId: string) => {
    await room.switchActiveDevice('audiooutput', deviceId);
  };
  const switchCamera = async (deviceId: string) => {
    await room.switchActiveDevice('videoinput', deviceId);
  };
  // List devices: Room.getLocalDevices('audioinput' | 'audiooutput' | 'videoinput')

  return (
    // ... render buttons with Aegean/Terracotta theme
  );
}
```

### Speaking Indicators

```tsx
// components/voice/VoiceParticipant.tsx
import { useParticipant } from '@livekit/components-react';

export function VoiceParticipant({ participant }) {
  const { isSpeaking, isMicrophoneEnabled, isCameraEnabled } = useParticipant({
    participant,
  });

  return (
    <div className={`voice-participant ${isSpeaking ? 'speaking' : ''}`}>
      <Avatar userId={participant.identity} />
      <span>{participant.name}</span>
      {!isMicrophoneEnabled && <MicOffIcon />}
      {isCameraEnabled && <CameraOnIcon />}
      {/* Green ring around avatar when speaking */}
    </div>
  );
}
```

### Video Grid

```tsx
// components/voice/VideoGrid.tsx
import { useTracks } from '@livekit/components-react';
import { VideoTrack } from '@livekit/components-react';
import { Track } from 'livekit-client';

export function VideoGrid() {
  const cameraTracks = useTracks([
    { source: Track.Source.Camera, withPlaceholder: false },
  ]);

  const screenShareTracks = useTracks([
    { source: Track.Source.ScreenShare, withPlaceholder: false },
  ]);

  // If someone is screen sharing, show focused layout
  if (screenShareTracks.length > 0) {
    return (
      <div className="video-layout-focused">
        <div className="screen-share-main">
          <VideoTrack trackRef={screenShareTracks[0]} />
        </div>
        <div className="camera-strip">
          {cameraTracks.map((track) => (
            <VideoTrack key={track.participant.sid} trackRef={track} />
          ))}
        </div>
      </div>
    );
  }

  // Otherwise, grid layout for cameras
  if (cameraTracks.length === 0) return null;

  return (
    <div className={`video-grid grid-${Math.min(cameraTracks.length, 4)}`}>
      {cameraTracks.map((track) => (
        <div key={track.participant.sid} className="video-tile">
          <VideoTrack trackRef={track} />
          <span className="video-name">{track.participant.name}</span>
        </div>
      ))}
    </div>
  );
}
```

---

## Feature Matrix

| Feature | How It Works | LiveKit API |
|---------|-------------|-------------|
| **Join voice channel** | Click channel -> fetch token -> `<LiveKitRoom connect={true}>` | `AccessToken` + `LiveKitRoom` |
| **Leave voice channel** | Click disconnect -> `room.disconnect()` | `useRoomContext()` |
| **Mute/unmute mic** | Toggle button -> `localParticipant.setMicrophoneEnabled()` | `useLocalParticipant()` |
| **Deafen** | Disable all remote audio tracks locally + mute mic. Uses `useRef` to persist state and `RoomEvent.TrackSubscribed` listener to apply to tracks arriving after deafen is toggled. | `remoteParticipant.audioTrackPublications` + `RoomEvent.TrackSubscribed` |
| **Toggle camera** | Toggle button -> `localParticipant.setCameraEnabled()` | `useLocalParticipant()` |
| **Screen share** | Toggle -> `localParticipant.setScreenShareEnabled()` | Browser picker dialog appears automatically |
| **Screen share + audio** | LiveKit supports system audio capture on some platforms | Included in screen share flow |
| **Speaking indicator** | Green ring on avatar -> `participant.isSpeaking` | `useParticipant()` |
| **Device selection** | Dropdown menu -> `room.switchActiveDevice(kind, deviceId)` | `Room.getLocalDevices()` |
| **Server mute (admin)** | Admin clicks mute -> backend calls `updateParticipant` | `RoomServiceClient` |
| **Kick from voice (admin)** | Admin kicks -> backend calls `removeParticipant` | `RoomServiceClient` |
| **See who's in voice** | Participant list from LiveKit + Socket.IO events for non-connected users | Webhooks + `useTracks` |
| **Video grid** | Auto-layout cameras in grid, focused view for screen share | `useTracks([Track.Source.Camera])` |
| **Noise cancellation** | LiveKit has built-in echo cancellation; Krisp integration available | `Room` options |
| **E2EE for voice** | LiveKit supports built-in E2EE for media tracks | `Room({ e2ee: { ... } })` |

---

## Voice Channel Types

### 1. Channel Voice (Discord-style)

- Channels have a `type` field: `text` or `voice`
- Voice channels show connected participants in the sidebar
- Clicking a voice channel joins it (no ring/call flow)
- Multiple people can be in a voice channel simultaneously
- Users see who's in each voice channel before joining

**DB change:** Add `type` column to `channels` table: `'text' | 'voice'`

**IMPORTANT:** Create a **new** migration file (e.g. `src/db/migrations/012_add_channel_type.sql`), do NOT modify existing migrations like `002_channels_and_members.sql`. Modifying old migrations breaks dev environments that have already run them.

```sql
ALTER TABLE channels ADD COLUMN type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'voice'));
```

### 2. DM Voice/Video Calls (Future)

- 1:1 or group DM calls with a ring/accept/decline flow
- Requires a signaling layer over Socket.IO for call initiation
- Ring -> accept -> generate token -> join room
- More complex UI (incoming call overlay, etc.)
- **Defer to Phase 4 of voice implementation**

---

## Permissions (New Bitmask Flags)

Add to existing permission bitmask system:

| Permission | Bit | Description |
|-----------|-----|-------------|
| CONNECT_VOICE | `1 << 20` | Can join voice channels |
| SPEAK | `1 << 21` | Can unmute and transmit audio |
| USE_VIDEO | `1 << 22` | Can enable camera |
| SCREEN_SHARE | `1 << 23` | Can share screen |
| MUTE_MEMBERS | `1 << 24` | Can server-mute others |
| DEAFEN_MEMBERS | `1 << 25` | Can server-deafen others |
| MOVE_MEMBERS | `1 << 26` | Can move members between voice channels |

**BEFORE IMPLEMENTATION:** Check `src/permissions.ts` and verify the highest existing permission bit is below `1 << 20`. If any existing flag uses `1 << 20` or higher, shift all voice permissions up to avoid collisions. Standard Postgres `integer` is 32-bit (up to `1 << 31`), so there is headroom, but verify your column type can accommodate the higher bits.

Token generation reads these permissions and maps them to `canPublishSources` (using `TrackSource` enum values) for server-enforced, source-level publish restrictions. Each permission flag (SPEAK, USE_VIDEO, SCREEN_SHARE) maps to specific `TrackSource` values rather than a coarse `canPublish` boolean.

---

## Phased Implementation

### Phase 1: Quick-Start Checklist

Before writing any feature code, set up the foundation:

1. **Infrastructure:** Update `docker-compose.yml` to add the LiveKit service (use Topology B for local dev)
2. **Database:** Create migration `012_add_channel_type.sql` (see Voice Channel Types section above -- do NOT modify existing migrations)
3. **Backend packages:** `npm install livekit-server-sdk fastify-raw-body`
4. **Backend code:** Create `src/routes/voice.ts` (token generation) and update `src/permissions.ts` (new bitmask flags -- verify no bit collisions first)
5. **Frontend packages:** `npm install livekit-client @livekit/components-react @livekit/components-styles`
6. **Frontend code:** Create the `VoiceChannelProvider` component

### Phase 1: Voice Channels (Build This First)
1. Add `livekit-server` to Docker Compose
2. Add `type` column to channels table + migration
3. Build `POST /api/voice/token` endpoint with permission checks
4. Build `VoiceChannelProvider` + `VoiceControlBar` components
5. Build `VoiceParticipant` with speaking indicators
6. Wire up join/leave via channel sidebar clicks
7. Add mic mute, deafen, disconnect controls
8. Socket.IO events for voice presence (who's in which channel)

### Phase 2: Video & Screen Share
1. Add camera toggle to control bar
2. Build `VideoGrid` with responsive layout
3. Add screen share toggle + focused layout
4. Device selector dropdown (mic/speaker/camera)
5. Build `ScreenShareView` with presenter-focused layout

### Phase 3: Admin Controls
1. Build server-side mute endpoint + UI
2. Build kick-from-voice endpoint + UI
3. Webhook receiver for room events
4. Voice channel participant list in sidebar

### Phase 4: DM Calls (Future)
1. Call initiation signaling over Socket.IO
2. Ring/accept/decline UI
3. Incoming call overlay component
4. 1:1 and group call support

---

## Testing Strategy

### Backend Tests
- Token generation returns valid JWT with correct grants
- Token generation respects CONNECT_VOICE permission
- Token generation rejects users without permission
- Admin kick endpoint verifies MOVE_MEMBERS permission
- Admin mute endpoint verifies MUTE_MEMBERS permission
- Webhook receiver validates signature

### Frontend Tests
- VoiceChannelProvider fetches token and renders LiveKitRoom
- Mic toggle updates localParticipant state
- Speaking indicator responds to isSpeaking
- Disconnect cleans up room connection
- Video grid renders correct layout for 1/2/3/4+ participants

### Integration Tests
- Full flow: authenticate -> join voice channel -> verify in participant list -> leave
- Admin mutes user -> user's canPublish becomes false
- Two users join same channel -> both see each other in participants

---

## Known Limitations & Gotchas

1. **Host networking varies by platform.** `network_mode: "host"` works natively on Linux. Docker Desktop on Mac/Windows has added host networking support in recent versions, but it may require enabling a feature flag in Docker Desktop settings. If it's unavailable or unreliable, use Topology B (port mapping with `node_ip`). See Docker Compose section above.

2. **ngrok won't carry voice.** UDP media needs direct connectivity or TURN. Plan for Cloudflare Tunnel or direct VPS for voice demos.

3. **Browser autoplay policies.** Some browsers block audio playback without user interaction. `<RoomAudioRenderer />` handles this, but you may need a "Click to unmute" prompt on Safari/iOS.

4. **LiveKit rooms auto-create.** When the first participant joins with a valid token, the room is created automatically. No need to pre-create rooms.

5. **Token expiry and renewal.** Token TTL only affects the *initial* connection -- an already-connected participant is not disconnected when their token expires. LiveKit server automatically refreshes tokens for connected clients when claims change (e.g. metadata or permission updates via `updateParticipant`). For Phase 1, `VoiceChannelProvider` uses a manual token fetch on mount, which is sufficient for typical voice sessions. For reconnection after unexpected disconnects (network drop, page refresh), listen on `RoomEvent.ConnectionStateChanged`: if `state === ConnectionState.Disconnected` and you did NOT call `room.disconnect()` yourself, re-fetch from `/api/voice/token` and **remount `<LiveKitRoom>` with the new token** (e.g. set a `key` prop tied to a reconnect counter, or toggle a state flag that unmounts/remounts the provider). Simply updating the `token` prop on an already-disconnected `<LiveKitRoom>` may not reliably re-establish the connection. Do NOT trigger re-fetch after intentional `room.disconnect()` calls (user clicked "Leave"). **Future optimization:** The JS client SDK v2 provides `TokenSource.custom()` which caches tokens and handles renewal/reconnect transparently. When moving beyond Phase 1, consider replacing the manual fetch with a `TokenSource` wired to `/api/voice/token` for cleaner lifecycle management.

6. **Redis is shared.** LiveKit and Agora share the same Redis instance. LiveKit uses different key prefixes, so there's no collision, but monitor memory usage.

7. **Screen share audio.** System audio capture during screen share works on Chrome desktop but is limited on Firefox and Safari. This is a browser limitation, not LiveKit's.

8. **Max ~3,000 participants per room** on self-hosted. More than enough for community voice channels.
