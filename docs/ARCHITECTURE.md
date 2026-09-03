# Encore — Architecture

> **Status:** living · canonical description of the system as built.
>
> This is the one architecture document. Detailed original specs are preserved under
> [`archive/reference/`](archive/reference/) for design archaeology, not as current instructions.
> Open work belongs in [`ROADMAP.md`](ROADMAP.md); operational traps belong in
> [`HANDOFF.md`](HANDOFF.md).

## 1. Product and core loop

Encore is a self-hosted karaoke server with two surfaces:

- **Phone remote:** QR join (name + color, no signup), unified YouTube/library search grouped by
  readiness, one-tap queue, singer-owned reordering, now-playing controls.
- **TV/stage:** attract → lobby → waiting → playing, gapless two-player playback, lower-third,
  lyrics, score, persistent join card.

The loop is deliberately simple:

> phone queues → server decides rotation → TV renders → server broadcasts truth → phones converge.

Round-robin is by **singer**, not FIFO: everyone's first pick before anyone's second. A song cooking
at the front is skipped without losing its fairness position (the **held-slot rule**).

## 2. Deployment and stack

```
┌─ Container 1: encore-core ───────────────────────────────────────┐
│ Bun · SvelteKit/Svelte 5 · Bun.serve HTTP + native WebSockets    │
│ Drizzle + bun:sqlite (WAL) · in-memory authoritative room state  │
│ yt-dlp + ffmpeg · phone UI + TV UI + REST + realtime hub         │
└───────────────────────────────────────────────────────────────────┘
┌─ Container 2: encore-worker ─────────────────────────────────────┐
│ Python · separator · WhisperX · ffmpeg                            │
│ dials home over WebSocket · stems + lyrics alignment + scoring   │
└───────────────────────────────────────────────────────────────────┘
```

| Layer | Choice | Constraint it satisfies |
|---|---|---|
| Runtime | **Bun 1.3.14** | native WS pub/sub, `bun:sqlite`, `Bun.spawn`, one core process |
| UI | **SvelteKit + Svelte 5 runes**, PWA | small bundle, fine-grained updates, phone-first |
| Adapter | `svelte-adapter-bun` | SvelteKit handler and WS hub served by `server.ts` |
| DB | **Drizzle + bun:sqlite**, WAL | durable index and party state without another service |
| Worker | **Python** | isolates the multi-GB ML stack from core |
| Media | yt-dlp + ffmpeg | source resolution, decode, encode, probing |
| Storage | local roots or S3/MinIO `MediaStore` | single-box default, remote-worker seam |

**Locked:** do not re-litigate Bun/Node/Deno. Performance comes primarily from the architecture, but
Bun's primitives map directly to it.

Repository shape:

```
packages/shared/   realtime contract + pure shared reducers
apps/core/         SvelteKit surfaces + Bun server + SQLite + media/job coordination
apps/worker/       dial-home Python worker + separator/WhisperX processors
docs/              ARCHITECTURE + HANDOFF + ROADMAP; history under archive/
```

## 3. Authority and realtime

Core is the single authority for queue and playback. Phones predict and command; TV renders and
reports telemetry; workers report progress and artifacts.

```
phone  ── commands ──► core ── queue/playback/media broadcasts ──► all clients
TV     ── telemetry ─► core
worker ── dial-home job protocol ─► core
```

Important events:

| Event | Direction | Purpose |
|---|---|---|
| `queue:patch` | core → all | authoritative diff plus revision and inline media snapshot |
| `queue:sync` | core → one | full state on connect/resync, including presence snapshot |
| `playback:state` | core → all | current entry, position, playing state |
| `nowplaying:changed` | core → all | current + up-next; drives TV preload |
| `media:status` | core → all | processing stage/progress/readiness |
| `singer:presence` | core → all | ref-counted online transition |
| `player:command` | phone → core | play/pause/skip/seek/restart |
| `tv:telemetry` | TV → core | actual playback position/end/buffering |
| `job:*` | worker ↔ core | assign/accept/progress/complete/fail |

### Optimistic reconciliation invariant

> **`client.predict(op) === server.apply(op)` for every mutation path**, including round-robin resequencing.

The mechanism is intentionally small:

1. Client mints a ULID for both the operation and any new queue entry.
2. Client applies the shared `QueueOp` immediately and stores its inverse in a pending-op map.
3. Server validates, applies the **same shared reducer**, increments monotonic `rev`, persists, then
   broadcasts the canonical patch with `causedBy: clientOpId`.
4. Origin clears pending and adopts canonical fields; other phones apply the same patch.
5. Reject applies the stored inverse and shows the reason.
6. Revision gap or reconnect requests `queue:sync`; pending operations rebase and resend
   idempotently.

`packages/shared/src/rotation.ts` is imported by both sides. Never fork its logic. Validate every
client field before it reaches state/SQLite — one missing `singerId` once killed the whole server.

## 4. Rotation, presence, and room state

### Rotation

`rotate` / `assignSeqs` / `applyAndReseq` own fairness. Terminal entries (`done`/`canceled`) are
pruned on apply and hydrate. A not-ready file entry is skipped by `isEntryReady` but keeps its
`rotationSeq`, so cooking never burns a singer's turn.

### Presence

The WS upgrade identifies a singer from the session cookie. `PresenceTracker` is ref-counted and
broadcasts only on 0→1 / 1→0. `queue:sync` carries the current online snapshot. Never infer presence
from the `singers` table — it is persistent and append-only.

### TV screen precedence

The pure `tvScreen()` decision is:

```
playing > waiting > lobby > attract
```

- **attract:** nobody present; full-screen QR.
- **lobby:** people present, no queue; hero QR + roster.
- **waiting:** queued media still cooking.
- **playing:** media, lower-third, lyrics/score, compact join card.

Spatial ownership is contractual: lower-third = bottom-left, join card = bottom-right, score =
top-right.

## 5. Gapless playback

TV owns two media surfaces: A is visible/current, B is hidden/warming `upNext`. Core sends up-next as
soon as rotation knows it, so B normally has minutes to buffer. On `ended`, TV reports telemetry and
swaps to B; it does not decide the next queue entry itself.

```
ATTRACT → LOADING → PLAYING ── ended ──► INTERSTITIAL → SWAP → PLAYING
                         └─ next not ready ─► WAITING ─► next ready/rotation advances
```

File media uses `<video preload="auto">`; YouTube uses a second cued iframe. If up-next changes, B
rewarm starts for the new entry. Skip is a synthetic `ended`. `INTERSTITIAL_MS=0` gives a pure
hard-cut; default is the short singer-reveal moment.

Implementation: `src/lib/tv/gapless.ts`, `TvPlayer.svelte`, server `realtime/player.ts`.

## 6. Media identity and storage

### Identity

`sourceRef` is **immutable origin identity**. Cooked playback lives in `Media.instrumentalRef`, and
players call `playbackRef(media)`. Never overwrite `sourceRef` with an artifact path: doing that made
a result unmatchable against its own future searches and minted duplicate uncooked rows.

### Storage classes

Split by **replaceability**, which makes backup and eviction policy obvious:

| Class | Default root | Contents | Policy |
|---|---|---|---|
| state | `DATA_DIR` | SQLite index, queue, singers, playback, jobs | small; back up |
| audio | `ENCORE_AUDIO_DIR` | native downloaded originals | unrecoverable; never auto-evict |
| derived | `ENCORE_DERIVED_DIR` | stems, pitch, lyrics | regenerable; first to evict |
| meta | `ENCORE_META_DIR` | authoritative sidecar JSON | tiny; portable; back up |

Refs remain portable relative strings whose first segment selects the root:

```
audio/<id>.<ext>
derived/stems/<id>-instrumental.flac
derived/stems/<id>-vocals.m4a
derived/pitch/<id>-pitch.json
derived/lyrics/<id>.json
meta/<id>.json
work/<jobId>/
```

`meta/<id>.json` is authoritative; SQLite is a rebuildable index. Sidecars preserve raw source
metadata, canonical metadata with provenance/confidence, artifact refs, tags, and play history. IDs,
not titles, name files. `safeMediaPath` performs containment per root.

### Audio policy

- Raw audio keeps YouTube's native container — no useless lossy→WAV transcode.
- Worker decodes transiently for separation; `work/<jobId>` is deleted by the **worker** that owns it.
- Instrumental is **16-bit FLAC**: the file heard at volume gets no second lossy generation.
- Vocals are **AAC 192k**: retained for ASR/pitch, not played to the room.
- Demucs emits 44.1 kHz; removing explicit `-ar 44100` is hygiene, not a sample-rate change.
- Stereo is the source ceiling; a 5.1.2 receiver upmixes it.
- `ENCORE_MEDIA_MAX_GB` is an optional soft cap; eviction is derived-only, true-LRU.

Measured migration: old per-song storage ~108 MB → ~14–21 MB depending on FLAC complexity; live
`derived/` fell from 911 MB to 136 MB without dropping library songs.

## 7. Worker and job lifecycle

Workers **dial home** to core, advertise `capabilities` and `concurrency`, and receive jobs over WS.
The durable SQLite ledger deduplicates `(mediaId, jobType)`.

```
queued → assigned → running → ready
   ▲         │          │
   └─ timeout/reject ───┘ (attempt++, retry until max)
                          └─ nonretryable/exhausted → failed
```

- Ack lease: assignment must be accepted in 10s.
- Progress lease: running job must report at least every ~30s.
- Reaper requeues expired jobs; boot resets orphaned `assigned`/`running` to `queued`.
- Priority is the earliest `rotationSeq` needing that media, not FIFO.
- A completed `stems` job enqueues `align` + `score` through `followUps()` — both need the vocals
  stem, so starting them before separation would race and contend.
- Core flips media refs/status only after the worker completes and artifacts exist.

The worker's stems path is orchestration, not numeric computation: it builds argv, spawns tools, and
parses progress. This is why separator engines can change behind the existing `Processor` protocol.

### Separator engines, models, and backends

Separation is selected along three independent axes:

| Axis | Chosen by | Meaning |
|---|---|---|
| **engine** | the room | which algorithm family — `demucs`, `roformer`, `ensemble` |
| **model** | the room | which checkpoint within that engine, from a fixed whitelist |
| **backend** | the worker | how that engine executes on this box — `torch`, `mlx`, `openvino` |

Engine and model are audible choices and live in room settings, broadcast to every client. Backend is
a property of the hardware a worker happens to run on and is never user-visible: the same `demucs`
engine runs through PyTorch on a Linux box and through MLX on Apple Silicon, producing the same stems.

A worker advertises a **capability token** per engine it can run, and dispatch routes a job by that
token, so a heterogeneous fleet works without the core knowing anything about hardware. A
demucs/torch worker advertises exactly `stems`, which keeps single-capability workers unchanged;
other combinations extend the token (`stems:roformer`, `stems:mlx`).

Backend selection is probed, never assumed. Auto-selection picks the fastest genuinely available
option and falls back to torch/CPU, which works everywhere. An **explicitly configured** backend or
device that is unavailable **raises at worker startup** rather than silently downgrading — a
misconfigured accelerator should be loud, not merely slow.

Intel Arc is a torch **device** (`xpu`), not a separate backend: IPEX registers it with torch, so the
pipeline is unchanged and only the dependency and device differ. `apps/worker/Dockerfile.intel` is
that image variant. OpenVINO is registered as a known backend but reports unavailable — Intel
publishes IR weights with STFT/iSTFT stripped for a C++ pipeline, so supporting it is a port rather
than a dependency.

### Settings scopes

Settings live in two layers, split by **who a setting belongs to**:

| Scope | Belongs to | Examples |
|---|---|---|
| **global** | the deployment and its worker fleet | default separator engine + model, upgrade policy |
| **room** | one party | interstitial pacing, a downward-only cook-quality ceiling |

Separator policy is global rather than per-room because an engine is only usable if some connected
worker advertises its capability — a fact about the server's hardware, not about a party. Two rooms
on one core cannot meaningfully disagree about whether a RoFormer worker exists.

The room layer is keyed by room id, so multi-room is a row per room rather than a migration. A room
may only cap cook quality **downward** (`maxQualityRank`): the global choice is already bounded by
what the fleet can run, so letting a room raise it would name an engine no worker advertises and the
job would sit queued forever. `resolveCookSeparator` applies that rule.

Both layers are authoritative server state. A write to either broadcasts `settings:changed` carrying
the combined payload, and `queue:sync` includes both for mid-party joiners — a client never merges
two events to learn the effective state.

### Quality ladder and upgrades

Engine+model pairs carry a declared quality rank, mirrored in the shared contract and the worker. A
completed cook can chain a `stems-upgrade` that re-separates from the **retained raw audio** — no
re-download — and the swap is refused unless the new artifact strictly outranks the published one.
`Media.separator` records what produced the current instrumental so that comparison is possible. An
unranked pair scores zero and can never win, so an unknown or de-whitelisted model cannot displace a
known-good artifact.

## 8. Lyrics and scoring

Lyrics separate **text acquisition** from **timing**:

- Text sources: LRCLIB, captions, ASR, reserved manual tier.
- Timing source: one WhisperX force-alignment layer for any text source.
- ASR transcription yields segment/line bounds, **not word timings**; `align()` supplies words.
- ASR always runs because it is both a fallback and a validation signal against confident wrong
  lookups, and it identifies language.
- Candidates are retained with source, timing fidelity, confidence, language and creation time;
  `pickBestLyrics()` chooses without destroying upgrade paths.
- Authoritative text + line timing ranks above ASR text + word timing: correct words with coarse
  highlighting beat wrong words with polished animation.
- Provenance is visible: auto-transcribed lyrics must not masquerade as authoritative.

Scoring compares live microphone pitch against a worker-extracted reference pitch track. The worker
advertises `score`; UI consumes `score:update`. No microphone on the development box means real flow
uses a synthesized pitch stream for machine verification.

## 9. Performance model

The load-bearing choices are architectural:

1. **Optimistic UI:** every mutation renders locally this frame.
2. **In-memory authoritative room state:** broadcasts never wait on a DB read.
3. **Gapless preload:** dead air is removed by warming the next player early.

Supporting rules: diff broadcasts on the hot path; full sync only on connect/gap; search debounce +
cancel + cache; heartbeat/reconnect/resync; transform/opacity-only motion; skeletons only where data
must arrive first. A moving worker progress bar turns unavoidable processing into watching rather
than waiting.

Do not prematurely optimize multi-node scale, SQLite query plans on non-hot paths, or transcoding
ladders. One room and one core are the intended default.

## 10. Security boundaries

Keep these intact:

- Thumbnail proxy: HTTPS-only + host allowlist (SSRF boundary).
- `/media`: per-root path-containment checks through `safeMediaPath`.
- Session token: unique index; singer identity comes from the cookie, not client claims.
- yt-dlp: query is one argv element, with a kill timer — never shell-concatenate user input.
- Containers: non-root, `no-new-privileges`, `cap_drop: [ALL]`, pinned base/dependencies.
- Workers dial home; core does not need inbound reachability to arbitrary worker hosts.

## 11. Historical source specs

The original standalone specs are preserved verbatim under [`archive/reference/`](archive/reference/):
optimistic reconciliation, TV preload, job lifecycle, performance, media storage, the original
master design, and the deferred vocal-guide proposal. They contain dated milestone language and
some superseded decisions; this document wins on conflict.
