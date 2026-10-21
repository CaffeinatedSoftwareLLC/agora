# Voice in and out

Talk to your agents and hear their replies, mainly from a phone: a push-to-talk microphone in the message box, and agent replies read aloud. Built for cloud handoff group C4 (`docs/planning/cloud-handoff.md`); issue #35 asked for free local speech with Kokoro.

## What you get

- **Microphone button** in the channel and thread message boxes. Hold it and talk, then let go; or tap once to start and tap again to stop (Esc cancels). The words go into the message box for you to check and edit. Nothing is sent by itself.
- **Read aloud** on any message: the speaker button in the hover toolbar, or **Read aloud** in the message's action sheet on a phone. Tap again (or **Reading aloud · Stop** above the message box) to stop.
- **Automatic read-aloud**, per person: Account & security → **Read replies aloud** → *Off*, *On my phone* (touch-screen devices) or *On every device*. New agent replies in the channel or thread you have open are read in order as they arrive. The choice is saved to your account, so your phone and computer agree. Phones only play sound that a tap started, so the tap that turns it on, or any tap on Read aloud or the microphone, lets later replies play.

## How it works

| Direction | Preferred engine | Fallback | Off when |
|---|---|---|---|
| Speech → text (voice input) | The server's **Transcription** route (`stt`), e.g. a local faster-whisper server. The browser records with `MediaRecorder` (Opus, or AAC on Safari) and uploads the clip | The browser's Web Speech API (`SpeechRecognition`), only if an admin allows it | Voice input is switched off, or neither engine is available |
| Text → speech (read-aloud) | The server's **Speech** route (`tts`), e.g. a local Kokoro server, when the admin ticks *Use this server's Speech route* | The browser's own voices (`speechSynthesis`), on-device voices first | Read-aloud is switched off, or neither engine is allowed |

The engines are ordinary [capability routes](api-reference.md#ai-providers): a Transcription or Speech route can point at any OpenAI-compatible server (the `openai` adapter now speaks the Audio API: `POST /audio/transcriptions` and `POST /audio/speech`). Gemini can also serve Speech with an API key, as it does for audio overviews. Each route keeps its daily limits and usage records; Settings → AI → Usage shows `stt` and `tts`.

The server reads a message, not text the browser sends: it turns the Markdown into something worth hearing (code blocks become "code block", links become "link", mentions become names, formatting marks go), cuts it at the admin's limit on a sentence, voices it, and returns MP3 (48 kbps; a phone may be on mobile data). A message read twice (the phone and the computer, or a replay) is voiced once: the last 64 clips stay in the API's memory.

## Choosing the engines: the evaluation

Requirement: prefer local, offline and free, and pick the best quality in each direction.

### Speech out: Kokoro (local) vs the browser's voices

| | **Kokoro** (Kokoro-82M via [Kokoro-FastAPI](https://github.com/remsky/Kokoro-FastAPI), OpenAI-compatible `/v1/audio/speech`) | **Browser `speechSynthesis`** (Web Speech API) |
|---|---|---|
| Quality | Neural voices with natural phrasing; the same voice on every device. Many English voices (`af_heart`, `af_bella`, `am_michael`, `bm_george`, …); also other languages | Whatever the device has. Apple devices and Android's Google voices are decent; Windows and Linux desktop voices often sound robotic. Varies per phone and computer |
| Offline / privacy | Runs on your server's CPU; text never leaves it | On-device voices stay on the device. Chrome's "Google …" voices are network voices: the text goes to Google |
| Cost | Free. Weights Apache-2.0; ~300 MB model, CPU only (no GPU) | Free |
| Phone behaviour | Plays as normal audio (MP3 through `<audio>`) | Works, but iOS and some Android browsers pause or cut speech when the screen locks or the tab changes |
| Running it | One container (`kokoro`, compose profile `voice`) | Nothing to run |

**Choice: Kokoro on the server's Speech route, with the browser's on-device voices as the fallback.** Kokoro gives the same good voice everywhere, for free, without sending text anywhere. The browser fallback (on by default) means read-aloud works on an instance with no speech server at all.

### Speech in: local Whisper vs the browser's recognition

| | **faster-whisper** (Whisper models via [speaches](https://github.com/speaches-ai/speaches), OpenAI-compatible `/v1/audio/transcriptions`) | **Browser `SpeechRecognition`** (Web Speech API) |
|---|---|---|
| Quality | Whisper writes punctuation and capitals, copes with accents and background noise, and handles technical words better than most. Pick the size to fit the CPU: `Systran/faster-whisper-small` is a good start, `…-medium` or `deepdml/faster-whisper-large-v3-turbo-ct2` are better and slower | Good in Chrome and Safari (each vendor's own service), with words appearing as you speak. Punctuation is unreliable. Firefox has none |
| Offline / privacy | Runs on your server; audio never leaves it | **Not local in most browsers:** Chrome sends the audio to Google, Safari to Apple (on-device only for some languages and devices) |
| Cost | Free (MIT) | Free |
| Browser support | Every current browser that records audio, including iOS Safari (AAC) | Chrome, Edge, Safari. Not Firefox; not every in-app browser |
| Latency | The clip is transcribed after you let go: a few seconds for a short message on a recent CPU with the small model | Streams while you talk |

**Choice: Whisper on the server's Transcription route.** It is the most accurate, works in every browser, and is the only option of the two that keeps audio on your own machine. The browser's recognition is an **off-by-default admin opt-in** because its audio goes to Google or Apple.

Also considered: running Whisper or Kokoro *inside the browser* (WebAssembly/WebGPU builds). Rejected for now: tens to hundreds of MB to download per device and slow on phones, which is where voice matters most.

## Setting it up

### 1. Start the speech servers

With the production stack (CPU only; first start downloads the images):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod --profile voice up -d kokoro whisper
```

speaches downloads Whisper models on request. Fetch the one you will use once (it is kept in the `whisper-models` volume):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod exec whisper \
  curl -fsS -X POST http://localhost:8000/v1/models/Systran/faster-whisper-small
```

For development, `docker compose --profile voice up -d kokoro whisper` publishes them on `127.0.0.1:8880` (Kokoro) and `127.0.0.1:8001` (whisper); use those addresses below.

### 2. Add them as providers (Settings → AI)

1. An instance admin turns on **Allow private network base URLs** (the containers have private addresses).
2. **Add provider** → *OpenAI / OpenAI-compatible*, label `Kokoro (local)`, base URL `http://kokoro:8880/v1`, no key.
3. **Add provider** → *OpenAI / OpenAI-compatible*, label `Whisper (local)`, base URL `http://whisper:8000/v1`, no key.
4. **Capabilities**: *Speech* → Kokoro (local), model `kokoro`, on. *Transcription* → Whisper (local), model `Systran/faster-whisper-small`, on.
5. **Voice**: tick *Use this server's Speech route*, set the voice (for example `af_heart`), save.

Cloud alternatives work the same way with an API key: OpenAI (`gpt-4o-mini-tts` / `whisper-1`, `gpt-4o-transcribe`), Groq (`whisper-large-v3-turbo`), or Gemini for Speech. Using a provider's API with your own API key is within its terms ([provider terms](provider-terms.md)); no CLI login is involved.

For OpenAI-compatible providers, choose **Speech** or **Transcription** beside **Test**. Saved routes
select the default; a provider without a route can be tested too. This checks the
speech server connection without generating audio. Use read-aloud or the microphone
to verify the actual output.

### 3. Each person

Account & security → **Read replies aloud**. The microphone needs HTTPS (or `localhost`): the Caddy and tailnet setups provide it; plain `http://<lan-ip>` does not.

## Admin settings

Settings → AI → **Voice** (`GET/PATCH /servers/:serverId/ai/voice`; changes appear in the AI changes list):

| Setting | Default | |
|---|---|---|
| Voice input | on | The microphone button, when an engine is available |
| Browser recognition fallback | **off** | Without a Transcription route, let browsers recognise speech (audio goes to Google/Apple) |
| Longest recording | 120 s | 5–600 |
| Language | detect | A code such as `en` or `pt-BR`. Whisper gets the language part (`pt`); browser recognition gets all of it |
| Read-aloud | on | The Read aloud action and automatic reading |
| Use this server's Speech route | **off** | The Speech route also voices audio overviews, so read-aloud with it is a separate opt-in |
| Browser voices fallback | on | |
| Voice | engine default | Passed to the Speech route: Kokoro `af_heart`, OpenAI `alloy`, Gemini `Kore` |
| Longest text read per message | 1500 characters | 100–4000 (OpenAI's speech endpoint takes up to 4096); longer replies are cut at a sentence and end with "The rest is in the message." |

## Limits and known gaps

- Speech for a long reply is synthesised whole before it plays; on a slow CPU the first words of a long message take a few seconds.
- The Audio API reports no usage for speech, and Whisper models report seconds, not tokens, so token-based limits and prices do not apply to these routes. Use the daily **request** limit to cap them.
- Automatic reading needs the page open; a phone that has locked its screen may suspend it.
- Bots cannot use the voice endpoints.
