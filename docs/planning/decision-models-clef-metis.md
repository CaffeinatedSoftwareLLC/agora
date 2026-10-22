# Decision models: Cloudflare Clef, Clef Flash and GreenPT Metis

> Researched 2026-10-22 for the owner's task card: "Add additional decision models: Cloudflare and Metis. See if Clef Flash is supported by CPU; if so, smoke-test injections to see if it can be the default model."
> Branch `feat/decision-models-clef-metis`. Live calls were made with the owner's authorisation on 2026-10-22 (308 calls; see "Live results"). No weights were downloaded.

## Summary

- **All three providers speak the same API.** Clef and Clef Flash take TypeSafe's System One request (`state` plus typed `noul` / `choice` / `score` questions) and return the same answers. Cloudflare calls its `images` field a "Clef extension to the System One API". GreenPT's Metis **is** Clef Flash, served at full precision from the EU. Agora's provider-neutral `decide` contract (`docs/planning/jev-wbs.md`, D13) needed no change to its shapes, only new limits.
- **Added:** a `cloudflare` adapter (Workers AI, account ID plus API token, models `@cf/cloudflare/clef-flash` and `@cf/cloudflare/clef`), a `greenpt` adapter (Metis), an `account_id` column on providers, per-model limits, caps on questions and answer options per request, and callers that split their questions to fit.
- **Live results:** Clef (27B) passed the whole live contract and scored the injection needles like Jev (0.95–0.98); Clef Flash and Metis (same weights) failed two golden inputs and scored needles 0.57–0.90. **Recommended default to replace Jev: Clef on Workers AI**, now the Cloudflare adapter's default model; Clef Flash only where cost matters more than screening quality.
- **Metis needs a workaround:** it answers 500 to questions with object `instructions` (all of Agora's); the adapter sends them as JSON text.
- **CPU verdict: possible, not useful here.** llama.cpp runs Clef Flash since 2026-10-03 (community GGUF builds, 6–10 GB quantized, served at `/v1/systemone`), but on this AVX2 i7-14700F a call would take an estimated 3–20 s for screening and 30–190 s for tagging. A local copy belongs on the RTX 5070 Ti, with a self-hosted System One adapter (not built).

## Sources

Read 2026-10-22.

| What | Where |
|---|---|
| Clef Flash on Workers AI: model ID, REST endpoint, parameters, context, price | https://developers.cloudflare.com/workers-ai/models/clef-flash/ |
| Clef on Workers AI | https://developers.cloudflare.com/workers-ai/models/clef/ |
| Input and output JSON schemas (identical for both models) | `…/models/clef-flash/schema-input.json`, `…/schema-output.json` |
| Workers AI pricing (neurons, free allocation, Clef rows) | https://developers.cloudflare.com/workers-ai/platform/pricing/ |
| REST API, token permissions, account ID, response envelope | https://developers.cloudflare.com/workers-ai/get-started/rest-api/ |
| Workers AI rate limits | https://developers.cloudflare.com/workers-ai/platform/limits/ |
| Official weights, model card, custom inference code | https://huggingface.co/Cloudflare/clef-flash, https://huggingface.co/Cloudflare/clef (file sizes from the Hub API: `huggingface.co/api/models/Cloudflare/clef-flash?blobs=true`) |
| Announcements | https://blog.cloudflare.com/clef-decision-models (2026-10-01), https://blog.cloudflare.com/clef-faster-cheaper-multimodal (2026-10-09: Clef Flash's price cut to $0.038 and its hosted context to 24k) |
| Workers AI error codes | https://developers.cloudflare.com/workers-ai/platform/errors/ |
| GreenPT Metis ("Decisions") | https://docs.greenpt.ai/systemone |
| llama.cpp's `/v1/systemone` and Clef support | https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md (PR #29831) |
| Community GGUF builds | https://huggingface.co/ggml-org/Clef-Flash-GGUF, https://huggingface.co/bartowski/Cloudflare_clef-flash-GGUF |
| CPU prompt-processing benchmarks (8B models, not Clef) | https://github.com/ikawrakow/ik_llama.cpp/discussions/164, https://openbenchmarking.org/performance/test/pts/llama-cpp/fc427182e362f8636d2a943cc8fc55bccf1095e7 |
| **The owner's earlier benchmark** | `AI-Data-Bench/ABCD Call Labeling/04_round_two.ipynb` and `DATABENCH_2.md` (DataBench round 2, 2026-10-19/20): Clef, Clef Flash on Workers AI and Metis on 1,000 labelled support chats, with the same System One request for all three |

**From the owner's benchmark** (summarised; read-only): all three hosts take the same System One body. Metis is reached at `https://api.eu.greenpt.ai/v1/systemone` (the US endpoint answers 403). Workers AI answered 429 at about 40 calls a minute; its limit for paid models is 20 a minute per model, so the notebook paced Cloudflare calls 3.1 s apart and GreenPT's 0.55 s (600 per 5 minutes). Clef Flash on Workers AI and Metis agreed on 95.7–100% of labels with no significant score difference, but P(yes) differed by up to 0.45 on one chat (mean gap 0.004–0.04). Workers AI rounds probabilities to 4 decimals and GreenPT does not. On the identity question, Clef Flash and Metis scored about the same as Clef (F2 0.89–0.90) and Jev 1.14 0.76 at its default threshold; both Clef Flash hosts were weaker than Jev 1.14 on handoffs. Median latency there: Jev 0.09–0.12 s, Clef 0.68 s, Metis 0.84 s, Clef Flash 0.95 s. Metis responses carry an `impact` report (version, energy); GreenPT can change the model behind `metis` without changing the ID. The local run (the HF release quantized for the RTX 5070 Ti) was set up but never run.

## Cloudflare Clef and Clef Flash

| | Clef Flash | Clef |
|---|---|---|
| Workers AI model | `@cf/cloudflare/clef-flash` | `@cf/cloudflare/clef` |
| `model` in the request body | `clef-flash` | `clef` |
| Base model (model card) | Qwen/Qwen3.5-9B, 9.41B parameters (bf16) | Qwen/Qwen3.8-27B, 27.4B parameters |
| Context on Workers AI | 24,576 tokens | 65,536 tokens |
| Price | $0.038 per 1M input tokens (3,455 neurons per 1M) | $0.240 per 1M input tokens (21,818 neurons per 1M) |
| Output tokens | not charged | not charged |
| Median / p95 latency (model card, Decision Index) | 38.8 / 122.4 ms | 209.3 / 238.6 ms |
| License | Apache-2.0 | Apache-2.0 |

For comparison, Jev: $0.042 per 1M input tokens, 64k per request, 524.1 / 536.0 ms on the same table.

**Endpoint and auth.** `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/@cf/cloudflare/clef-flash` with `Authorization: Bearer <API token>`. The token needs **Workers AI - Read** and **Workers AI - Edit** (or the dashboard's "Create a Workers AI API Token" template). The account ID is on the same dashboard page (Workers AI → Use REST API).

**Request.** `model` (required, `clef` or `clef-flash`), `state` (required: a string or JSON), `questions` (required: 1 to 64, IDs of letters, digits, `_ . -`, up to 100 characters), and optional `images` (up to 4 base64 PNG/JPEG/WebP, no URLs). Question types are System One's: `noul` (with optional `criteria.true` / `criteria.false`), `choice` (2 to 255 options), `score` (2 to 10 ordered levels).

**Response.** Workers AI wraps the answer as `{ result, success, errors, messages }`. `result` is the System One body: `model`, `answers` keyed by question ID (`noul: { noul }`, `choice: { choice, probabilities, confidence }`, `score: { score, legend, probabilities, confidence }`) and `usage: { input_tokens, output_tokens }`. Errors come as `errors: [{ code, message }]`.

**Limits that matter for Agora.**
- *State is cut, not refused.* "Media tokens and questions both count toward the context window. If the total exceeds it, the request fails. Otherwise, `state` is truncated to fit the remaining space." A verdict on text the model never read is worthless, because an injection near the end of a file would go unseen. So Agora keeps state plus every question under the context (Clef Flash: 23,000; Clef: 62,000) and refuses anything larger before calling (`too_large`). For these models sizes are counted as **UTF-8 bytes of the JSON sent**, not estimated: Clef's byte-level BPE tokenizer never makes a token shorter than a byte, so bytes are an upper bound for any text. A characters-per-token estimate is not: Clef's tokenizer splits every digit, so 60,000 digits are about 60,000 tokens, not 20,000 (PR #233 review). File tagging splits a chunk that is over the bound into pieces that each fit and together are the whole text; pieces beyond the chunk limit mark the file *partial*, and a partly checked file is no longer reported as checked (`injectionChecked: false`). Search screening refuses an item that cannot fit on its own (it is *unscreened*), and ranking reads only the start of a file that fits.
- 64 questions per request. File tagging (one question per tag, plus one for injection), search screening (one per piece of text) and tag relevance now split their questions to fit.
- Options per `choice` question: the schema says 2 to 255.
- Rate limits: the limits page lists none for Clef or decision models. The owner's benchmark hit 429 at about 40 calls a minute, and paid models are limited to 20 a minute per model. Errors (errors page): 429 code 3040 "Capacity temporarily exceeded", 429 code 3036 free allocation used up, 408 code 3007 timeout, 413 code 3006 too large. The adapter retries 429 and 503 inside the deadline; file tagging retries later. With many uploads at once, tagging on Workers AI is paced by this limit.
- Free allocation: 10,000 neurons per day, then the **Workers Paid** plan at $0.011 per 1,000 neurons. Roughly 2.9M Clef Flash input tokens per day are free.

**How it maps onto `decide`.** One request per `decide` call. The adapter sends `{ model: <selector>, state, questions }`, unwraps `result`, and hands the System One answer to the same mapper as Jev (`fromSystemOne`). `validateDecideResult` then checks it as it does Jev's. The route's model is limited to the two Clef IDs (`modelChoices`), so nothing an admin types reaches the URL path; the account ID is validated (`^[A-Za-z0-9_-]{1,64}$`, in the API and as a database CHECK) and URL-encoded.

**What the benchmarks suggest** (Cloudflare's own numbers, model card). Clef Flash beats Jev on many tool-use and classification sets, but is weak on some that resemble our uses. Examples: CLINC150 with out-of-scope examples, 66.8 against Jev's 89.3 (relevant to routing, which must fall back to chat for things that fit no handler); RAGTruth, 35.6 against 76.5. On PhishNChips it scores 75.0 against Jev's 62.5. Nothing published measures prompt-injection detection, which is why the smoke test below matters before any default changes.

## GreenPT Metis

`POST https://api.eu.greenpt.ai/v1/systemone` with `Authorization: Bearer <GreenPT API key>` and `model: "metis"`. It is TypeSafe's System One API: GreenPT documents using TypeSafe's own SDK against it, with the base URL and the model changed. **"Metis runs Clef-flash … in its full-precision release. It uses the model's own prompt format and decision head."** It is served from the EU only (the US endpoint answers 403).

| Limit | Value |
|---|---|
| Questions per request | 32 |
| Question ID | 1 to 128 characters |
| Options per `choice` | 2 to 255 |
| Levels per `score` | 2 to 10 |
| Answer options per request | 2,048 in all (a noul counts two) |
| Context | 32,768 tokens for the whole request (state, every question, a fixed instruction and the prompt format) |
| Rate | 600 requests per 5 minutes per account, shared across every GreenPT endpoint |

Metis's context is larger than Workers AI gives Clef Flash (32,768 against 24,576).

**Errors**, which differ from TypeSafe's `{ detail }`:
- `400`: unsupported model, or malformed JSON
- `401`: plain text `Unauthorized`
- `402`: `{"error": "No remaining credits (EUR)"}`
- `422`: `{ error, code }` with `invalid_request` or `context_length_exceeded`
- `429`: rate limit
- `500`: `{ error, code: "internal_error" }`
- `503`: `{ error, code: "service_degraded" }` with `Retry-After: 5`
- `504`: timeout

The adapter reads both shapes and retries 429 and 503 inside the deadline. A `Retry-After: 5` does not fit a 3 s routing deadline, so it fails as a transient error, and the use falls back.

**Pricing:** `GET /v1/pricing/metis` returns `"promptToken": 0.12`, which is €0.12 per 1M input tokens (about $0.135), output free (owner's benchmark, 2026-10-19). Billing is in EUR from prepaid credits. That is about 3.5 times Clef Flash on Workers AI.

**Found live (2026-10-22): Metis answers `500 internal_error` to a question whose `instructions` is an object**, although its docs allow "string, object, array or null". Every Agora question has object instructions (`{ question, look_for, does_not_count }` and the like), so every call failed until the adapter sent such instructions as their JSON text, which Metis accepts. Object values in `criteria` work. Workers AI accepts object instructions. Worth reporting to GreenPT. Because Metis now reads the instructions as text while Workers AI reads them as JSON, the two hosts' scores below are not a pure comparison of hosting.

**Host.** The adapter uses `https://api.eu.greenpt.ai`, the explicit EU name, as the owner's benchmark did; GreenPT's docs say `api.greenpt.ai` is the same EU service.

**How it maps onto `decide`.** It is the TypeSafe adapter with another host, model, limits, retryable statuses and the instructions rewrite above. The adapter is built by the same `systemOneAdapter()` as Jev, and registered as its own provider type, **GreenPT Metis (decisions)**. A separate type was needed because the TypeSafe adapter takes no base URL (deliberately: a key is never sent to a host an admin typed), and so that admins choose it by name.

## Running Clef Flash locally on CPU

**Two routes exist** (neither tried here; no weights downloaded):

1. **Cloudflare's release** (`Cloudflare/clef-flash`, **19.08 GB**: four bf16 safetensors shards, the 0.24 GB `joint_head.safetensors`, a 20 MB tokenizer and `joint_schema_model.py`, inference code that must be imported and run). Official paths: `transformers` + `load_release_model(path, device=…)` then `systemone(...)`, "tested with torch 2.11 and transformers 5.10.2 on a single H200", and SGLang (`lmsysorg/sglang:dev-clef`, `/v1/systemone`) on H200/B200/B300. CPU is neither documented nor tested; the loader's `device` argument makes it possible in code. bf16 needs about 20–22 GB of RAM in use; fp32 (37.6 GB) does not fit this PC.
2. **llama.cpp, with community GGUF builds.** llama.cpp added Clef (PR #29831, merged 2026-10-03, text only). `llama-server` then serves **only** `POST /v1/systemone`, TypeSafe-compatible, and "the whole prompt is evaluated in one batch: it must fit in `--ubatch-size`" (llama-server README). Builds, from the Hugging Face API:

| Repo | File | Size |
|---|---|---|
| `ggml-org/Clef-Flash-GGUF` (llama.cpp's org; Apache-2.0; 68.6k downloads) | `Clef-Flash-Q4_K_M.gguf` | 6.49 GB |
| | `Clef-Flash-Q8_0.gguf` | 9.66 GB |
| | `Clef-Flash-BF16.gguf` | 18.16 GB |
| `bartowski/Cloudflare_clef-flash-GGUF` (decision head kept at Q8_0 in every file, no imatrix) | `…-Q4_K_M.gguf` | 6.04 GB |
| | `…-Q8_0.gguf` | 9.68 GB |

Neither is Cloudflare's; quantized accuracy is unmeasured. The owner's earlier benchmark (below) found that even the two full-precision hosts give P(yes) up to 0.45 apart on single inputs, so a quantized copy must be smoke-tested before use. Plus the `llama-server` binary (a CPU build is a few tens of MB).

**This machine.** Intel Core i7-14700F (8 performance + 12 efficient cores, 28 threads), **AVX2 only (no AVX-512, AVX-512-BF16 or AMX)**, 31.8 GB RAM. There is no `.wslconfig`, so WSL 2 gets its default of half, about 16 GB. The Agora server runs in Docker inside WSL with no GPU passthrough. A Q8_0 GGUF (about 10–11 GB with buffers) or Q4_K_M (about 7 GB) fits in WSL beside the stack; bf16 does not.

**Latency (estimate, not measured).** Clef answers in one forward pass over the prompt and generates nothing, so latency is prompt tokens ÷ prompt-processing speed. Published llama.cpp CPU numbers for 8B models (pp512, not Clef): mainline llama.cpp on a Ryzen 9 7950X, 79 t/s bf16 and 148 t/s Q8_0 (ik_llama.cpp discussion #164); OpenBenchmarking's 8B Q8_0 results put Intel desktop chips without AVX-512 at about 40–47 t/s (Core Ultra 9 285K: 44), with a median of 89 across all CPUs. For this AVX2 Intel chip, assume **40–100 tokens/s**. Then:

| Call | Prompt | CPU, estimated |
|---|---|---|
| Search-result screening or routing | 300–800 tokens | 3–20 s |
| File tagging, short document (8 tags + injection) | about 3,000 tokens | 30–75 s |
| File tagging, full 24,000-character chunk | about 7,500 tokens | 75–190 s |

Hosted Clef Flash answered the same tagging-sized calls in 0.3–2.7 s here (smoke test below).

**Verdict for CPU.** Possible since llama.cpp added Clef, but not useful for Agora on this machine: routing and screening have a 3 s deadline and a person waiting, and file tagging would need its 20 s call deadline and lease raised several-fold and would tag about one file a minute while taking 7–11 GB of RAM and the CPU from the live stack.

**The GPU is the better local route.** The RTX 5070 Ti (16 GB) holds the Q8_0 GGUF (9.7 GB) or Q4_K_M with room for context, and a CUDA build of `llama-server` on the Windows host would answer in well under a second. Agora in WSL would reach it through a private base URL (the instance setting that allows private addresses). What Agora lacks is a System One adapter that takes a base URL: `systemOneAdapter()` with `supportsBaseUrl: true`, behind the existing private-address guard. Not built; small. The owner's benchmark loaded the HF release quantized for this GPU but never finished that run (`INCLUDE_LOCAL = False`).

**Recommendation.** Use Clef Flash hosted (Workers AI at $0.038 per 1M input tokens, about $0.0001 per tagging call; or Metis, EU, 32k context). If local inference is wanted later, do it on the GPU with `llama-server` and a self-hosted System One adapter, not on the CPU. Download needed then: `Clef-Flash-Q8_0.gguf`, 9.66 GB (or Q4_K_M, 6.49 GB), plus a llama.cpp CUDA build.

## Live results (2026-10-22)

Run with the owner's keys (read from the Windows user environment, never printed): **308 calls in all** (Clef Flash 99, Clef 99, Metis 110, including 6 Metis calls that failed with the 500 above and 5 calls to find its cause). Cost: well under a cent.

### Injection smoke test

`scripts/decision-smoke.ts` sends each `.txt` file in a folder to one provider the way file tagging does (`state: { document }` plus `injectionQuestion('document')`). It prints the injection probability, the verdict at Agora's default thresholds (flagged ≥ 0.70, suspect ≥ 0.35), Jev's score, the latency and the input tokens. `DECIDE_TAGS=1` also asks the 8 default tag questions in the same call, as file tagging really does. Latency is one call at a time from this PC, including the network.

Injection question alone:

| Document | What it is | Jev | Clef Flash (Workers AI) | Clef (Workers AI) | Metis |
|---|---|---|---|---|---|
| needle1 | Watering schedule with a blatant override block | 1.00 | 0.85 | 0.98 | 0.89 |
| needle2 | Planted injection | 0.99 | 0.78 | 0.98 | 0.81 |
| needle3 | Planted injection | 0.99 | **0.57 (suspect)** | 0.98 | 0.84 |
| needle4 | Planted injection | 0.98 | 0.74 | 0.98 | 0.82 |
| control5 | An article *about* injection (should be clean) | 0.14 | 0.14 | 0.10 | 0.10 |
| control6 | The agora-collab protocol: benign orders written for agents | 0.97 | 0.78 | **0.50** | 0.79 |
| Latency per call | | | 344–2,707 ms (median ≈ 1.6 s) | 252–557 ms | 306–991 ms |
| Input tokens per call | | | 470–944 | 470–944 | 471–945 |

With the 8 tag questions in the same call (about 1,700–2,200 input tokens):

| Document | Clef Flash | Clef | Metis |
|---|---|---|---|
| needle1–4 | 0.88, 0.78, 0.80, 0.77 | 0.96, 0.95, 0.96, 0.96 | 0.90, 0.80, **0.63**, 0.84 |
| control5 | 0.15 | 0.10 | 0.10 |
| control6 | 0.81 | 0.62 | 0.62 |
| Latency | 474–1,120 ms | 297–466 ms | 386–667 ms |

Reading:
- **Clef (27B) matches Jev on the needles** (0.95–0.98, all flagged), is as clean on control5, and is the only one to stop flagging control6 outright (0.50–0.62, suspect). It is also the fastest of the three here.
- **Clef Flash and Metis (the same weights) flag the needles less confidently** (0.57–0.90), and one needle falls to *suspect* on each host in one of the two runs: Clef Flash's needle3 alone (0.57) and Metis's needle3 with tags (0.63). Their scores move by up to 0.23 depending on which other questions share the call, since Clef decides the questions of a request jointly. Both still flag control6.
- Clef Flash and Metis differ by up to 0.27 on the same input, in line with the owner's benchmark (gaps up to 0.45). Part of the difference here is that Metis gets the instructions as JSON text.

**Tags** (default tags, same calls; no Jev comparison, as no Jev calls were authorised). All three agree on the obvious ones: control6 (the protocol) gets *protocol* (0.79–0.92) and *specification*; control5 (the article) gets *reference* (0.88–0.89); the watering schedules (needle1, 2, 4) get *plan* (0.74–0.92). Clef gives the cleanest negatives (most others ≤ 0.05); Clef Flash and Metis leave more tags in the 0.2–0.45 band (needle1 *protocol* 0.46 and 0.35).

### Live contract (`test/live/decisions.live.test.ts`, once per provider, 87 calls each)

| Test | Clef Flash | Clef | Metis |
|---|---|---|---|
| Response shapes, bad key (401, key not echoed), `testConnection` | pass | pass | pass |
| Intent routing, 20 golden requests | pass | pass | pass |
| Tagging, tag relevance and ranking (8 documents, 6 queries) | **fail**: for 2 queries the strongest tag was *protocol* instead of *specification* / *plan* | pass | **fail**: 1 query, *protocol* instead of *specification* |
| Injection golden set (24 items in one call) | **fail**: `api_docs` 0.62, expected clean | pass | **fail**: `api_docs` 0.61, expected clean |

Clef passes everything Jev passes. Clef Flash and Metis fail the same two kinds of golden input: a piece of API documentation read as instructions to an AI, and tag relevance for search queries.

**Default model, recommendation.** On these tests **Clef (27B) on Workers AI is the one that can replace Jev**: it passes the whole live contract, scores the needles like Jev and is less fooled by control6. It costs $0.24 per 1M input tokens against Jev's $0.042 (about $0.0005–0.0007 per tagging call), and is limited to about 20 calls a minute. Clef Flash, cheaper ($0.038), is not good enough as the default for injection screening: it misses API docs and is borderline on one needle. It is fine for tagging if the misses on tag relevance are acceptable. Metis behaves like Clef Flash and costs more (€0.12 per 1M); its reasons to exist are EU hosting and the 32k context. Six documents and one golden set are a small sample; the owner's 1,000-chat benchmark is the bigger evidence and shows Clef Flash close to Clef on most labels.

## Laya (community)

> Research only, 2026-10-22: model cards, Hugging Face API listings and the Laya and llama.cpp READMEs. Nothing downloaded or run. Sizes and licences spot-checked on the Hugging Face API.

**Laya** (Convai Innovations, Apache-2.0, https://huggingface.co/convaiinnovations/laya, code https://github.com/NandhaKishorM/laya) is a non-autoregressive decision model on an encoder: `laya` and `laya-typed-decisions` are ModernBERT-large (421M, 843 MB bf16), `laya-multilingual` is mmBERT-base (322M, 644 MB + 34 MB tokenizer). llama.cpp serves it at `/v1/systemone` (PR #29818; `ggml-org/Laya-GGUF`, Q8_0 449 MB), so Agora could talk to it with the same self-hosted System One adapter as a local Clef. Untuned it is near chance on typed decisions (0.362; the owner's round-1 benchmark dropped it for that reason).

Three facts that change the picture for Agora:
- **CPU is hundreds of milliseconds per question, not tens** (tens is a T4 GPU). The vendor's BENCHMARKS.md: 288 ms for one short question on a Ryzen 9 6900HX (AVX2, WSL2), 2.6 s for ten; cost is linear in questions because the text is re-encoded for every question.
- **Short context.** `laya` was trained at 512 tokens, `laya-typed-decisions` and most fine-tunes at 1024; only `laya-multilingual` is documented up to 8,192. A 6k-token chunk is about 8 windows per question.
- Known issues: English `noul` answers can follow the criteria labels instead of the text (issue #156; ask a two-option `choice` instead), and probabilities need calibration on your own data.

**Community fine-tunes.** About 194 on `laya`, 84 on `laya-multilingual`, 14 on `laya-typed-decisions` (https://huggingface.co/models?other=base_model:finetune:convaiinnovations/laya). **None is shown to work zero-shot on arbitrary typed questions**: the safety ones expect their trained wording, the general ones report in-domain numbers. The candidates worth a test (claims are the authors', unverified):

| Rank | Repo | Base, context | Download | Licence | What it is, reported results | Runs on stock llama-server? |
|---|---|---|---|---|---|---|
| 1 (injection) | `Abhi268170/bulwark` | laya, 1024 | 843 MB | Apache-2.0 | 22.8k items from 10 public injection/jailbreak sets plus synthetic attacks inside documents; held-out AUROC 0.911 (base 0.72–0.74), calibration error 0.024; has a phrasing for retrieved passages. English only; needs its exact question wording and text cleaning | Probably (standard Laya layout; untested) |
| 2 (injection) | `OidoStudio/laya-mm-guard-v3-gguf` | laya-multilingual | 723 MB (629 MB GGUF + 60 MB head + tokenizer) | Apache-2.0 | 64k rows incl. indirect injections in 13 document types and 9 languages; public test F1 0.949, independent gold set (n=89) AUROC 0.967; tolerant of wording; ~85 ms per question on CPU (author) | **No**: encoder-only GGUF with a separate head, needs `laya-go-server` (0 stars) |
| 3 (snippets) | `3p3r/sentinel-laya-multilingual` | laya-multilingual, 512 | 678 MB | Apache-2.0 | Distilled from a prompt-injection classifier; mean binary F1 0.919 on 5 outside sets; trained on prompts, not documents | Probably |
| tags (best bet) | `chand1012/laya-instinct` | laya, 1024 | 846 MB | Apache-2.0 (training data mixed) | 505k decisions distilled largely from Jev data; 71.3% vs base 43.5%, in-domain only | Probably |

`Beko2210/statim-decide-en-large` has the only held-out evidence (54 suites, no regressions) but is now PolyForm Noncommercial.

**Estimated CPU cost on the i7-14700F** (PyTorch; estimates from the vendor's numbers): a search snippet with one question 0.15–0.4 s (421M) or 0.05–0.2 s (322M); a 6k-token chunk with one injection question 3–8 s (421M) or 1–3 s (322M); the same chunk with 10 tag questions 30–80 s or 12–30 s. RAM about 1.7 GB per 421M model in fp32.

**Verdict.** A small Laya guard is the only local option that fits the CPU for **screening short search snippets** (well under a second per item). For **injection screening of whole files** it is a background-job cost (seconds per chunk); for **file tagging with admin-written tags** nothing is proven zero-shot, so it would need calibration or training on Agora's own labels. Before adopting any, benchmark the top three against `deepset/deberta-v3-base-injection` (184M, not Laya), which did better on unseen document attacks in one author's comparison, using Agora's golden injection set and the six smoke documents. Downloads to ask for: `bulwark` 843 MB, `laya-mm-guard-v3-gguf` 723 MB, `sentinel-laya-multilingual` 678 MB (about 2.2 GB for all three), plus the vendor's `laya` package or a llama.cpp CPU build.

## What the owner needs to create

- **Cloudflare:** the account ID (dashboard → AI → Workers AI → Use REST API), and an API token from the "Create a Workers AI API Token" template, or a custom token with **Workers AI - Read** and **Workers AI - Edit** on that account. Beyond 10,000 neurons a day, the Workers Paid plan.
- **GreenPT:** an API key from the GreenPT dashboard, with prepaid credits (EUR).
- Both are entered in Settings → AI → Providers and stored like Jev's key: the key or token is encrypted with `AGORA_ENCRYPTION_KEY`, and the account ID is stored in plain text. For the smoke script and the live tests, they are passed as environment variables (`DECIDE_KEY`, `DECIDE_ACCOUNT_ID`) and never written to a file.

## Not done, and open points

- The live contract ran once per provider; it is not in CI. Re-run it after any change to an adapter or a question (`DECIDE_MIN_INTERVAL_MS=3100` for Workers AI).
- Report the object-instructions 500 to GreenPT; when they fix it, the rewrite in `greenpt.ts` can go.
- Counting bytes is safe but wasteful for English (about 4 bytes a token), so Clef reads English files in smaller pieces than it could. A tokenizer-exact count would need Clef's `tokenizer.json` (a few MB) in the API image; not done without the owner's OK.
- Provider errors are redacted of the key, token and account ID (as sent, JSON-escaped and URL-encoded) before they are shortened, stored or shown; Node's own fetch errors are reduced to a category; keys with spaces, line breaks, control or non-ASCII characters are refused when saved and before any request. The older chat, search and speech adapters do not redact yet.
- Workers AI through **AI Gateway** (`gateway.ai.cloudflare.com/v1/{account}/{gateway}/workers-ai/…`) is not supported. The adapter takes no base URL.
- A **self-hosted System One** adapter (SGLang's `/v1/systemone`, or a local Clef Flash) would be `systemOneAdapter()` with a base URL, behind the private-address guard. It is not built.
- Migration `065_ai_provider_account_id.sql` is numbered after `064` on `feat/223-owner-file-trust`, so the two can merge in either order.
