# 🎤 Karaoke — Master Design Doc

Status: **LIVING** · MVP-locked
This is the canonical index. Deep specs live in sibling files and are linked inline.

> **Thesis.** Self-hosted karaoke that is *cleaner and faster than any incumbent*. The
> functional niche (YouTube queue + mobile remote + TV) is filled by PiKaraoke; the
> **quality/UX niche is wide open**. Design and feel are the moat. The smart feature
> (stem-separation → make-karaoke-from-any-song) is the defensible differentiator nobody
> has packaged into a polished self-hosted product.

---

## 1. Product — two surfaces, one loop

**📱 Phone (the remote — the star).** Join via QR (name + color, no signup wall) → unified
search (`YouTube` / `Library` tabs) → one-tap "Add to my turn" → the queue/rotation screen
(who's up, your songs, drag-reorder your own) → now-playing control strip.

**📺 TV / Stage (a dumb renderer that obeys the server).** Idle/attract (big join QR + up-next
ticker) → now-playing (video + `Now singing: NAME` lower-third + lyric slot) → interstitial
(`Next up: NAME — SONG`).

**The core loop:** *phone queues → server decides rotation → TV plays → server broadcasts
state → every phone mirrors it.*

Mock: `/local/home/angryang/.meshclaw/workspace/karaoke-design/phone-ui-mock.html`

---

## 2. Architecture — 1 container now, +1 when stems land

```
┌─ Container 1: karaoke-core ─────────────────── (the whole MVP) ─┐
│  Bun runtime — SvelteKit (svelte-adapter-bun) mobile UI + TV    │
│  Bun.serve: HTTP + native WS pub/sub hub (one Bun process)      │
│  REST (+server.ts) · Drizzle + bun:sqlite (WAL, built-in)       │
│  in-memory authoritative state · bundled yt-dlp + ffmpeg        │
│  volumes:  /data (sqlite)   /media (library + cache)            │
└─────────────────────────────────────────────────────────────────┘
┌─ Container 2: karaoke-worker ──── (add for stems + scoring) ─────┐
│  Python: Demucs (htdemucs) + WhisperX + ffmpeg                  │
│  dials home to core over WS · pulls source / pushes stems       │
└─────────────────────────────────────────────────────────────────┘
```

- **Core is always one process** and the single source of truth.
- **Workers dial home** (connect *to* core), so they scale to N and run on any box / GPU
  across NAT. Single-box mode = one in-process worker thread using the identical protocol.
- **MediaStore is an interface** — `local` volume (default) or `object-store` (MinIO/S3) when
  workers are remote. Flip via env var.
- Two **abstraction flags carry the whole future**: `Media.playMode (iframe|file)` and the
  `MediaStore` interface. Cost nothing now, prevent a rewrite later.

---

## 2a. Tech Stack — **LOCKED**

Runtime decided **Bun** (over Node) on 2026-06-29. Speed comes from the *architecture* (§7),
but Bun's primitives line up with this app's exact shape and the aarch64/one-container goal.

| Layer | Choice | Why it serves "uber fast / one container" |
|---|---|---|
| **Runtime** | **Bun** | Single binary = runtime + bundler + pkg mgr + TS executor. Native TS (no server build step), faster cold start (helps boot-rehydrate + `compose up`), simpler Dockerfile (`FROM oven/bun`). |
| **UI** | **SvelteKit + Svelte 5 runes** | Compiles away — no VDOM, tiniest bundle, fastest first paint. Runes = only the changed queue row re-renders. |
| **Delivery** | **PWA** (installable, offline app-shell) | QR → installed → singing in seconds; instant warm loads. |
| **SvelteKit adapter** | **`svelte-adapter-bun`** (community) | ⚠️ the one non-first-party seam. Verify on aarch64 at scaffold time; fallback = `adapter-node` run on Bun. |
| **HTTP + Realtime** | **`Bun.serve` native WebSocket pub/sub** | `ws.subscribe("room:main")` + `server.publish(...)` — native C++ fan-out maps 1:1 onto our diff-broadcast model. No Socket.IO, no hand-rolled client registry. |
| **DB** | **`bun:sqlite` (WAL, built-in)** | Synchronous + in-runtime → **no node-gyp / native-compile** (kills a class of ARM Docker pain). Perfect for reads-from-RAM + write-behind. |
| **ORM** | **Drizzle** | Lightweight, great TS types, zero ramp (VROOM stack). Runs on `bun:sqlite`. |
| **Subprocess** | **`Bun.spawn`** | Fast/ergonomic shell-out to the bundled media binaries. |
| **Media tools** | bundled **yt-dlp + ffmpeg** | metadata/stream resolve + transcode; yt-dlp metadata cached (never re-resolve a video id). |
| **MediaStore** | interface: `local` (default) / `object-store` (MinIO/S3) | flip via env var when workers go remote. |
| **Worker (container 2)** | **Python: Demucs `htdemucs` + WhisperX + ffmpeg** | quarantined multi-GB ML/torch; dials home over WS. |

**The one seam to de-risk:** `svelte-adapter-bun` is community-maintained. First scaffold step is
to confirm a SvelteKit prod build serves under Bun on aarch64; if it's rough, run first-party
`adapter-node` *on* the Bun runtime (keeps `bun:sqlite` + `Bun.serve` benefits). Nothing else in
the design depends on the runtime — it's swappable.

---

## 3. Realtime engine + event vocabulary

Server is **authoritative** for playback and queue. TV never decides — it renders state and
reports telemetry. Phones are mirrors + command senders.

```
phone  ──REST/WS──>  server   (mutations: join, queue add/remove/reorder)
phone  ──WS───────>  server   (commands: play/pause/skip/seek/restart)
server ──WS───────>  ALL      (broadcasts: queue diffs, playback:state, nowplaying:changed)
TV     ──WS───────>  server   (telemetry: position, ended, buffer state)
worker ──WS───────>  server   (dial-home: hello/heartbeat/progress/complete/failed)
```

| Event | Dir | Payload |
|---|---|---|
| `queue:patch` | core→all | `{rev, ops[]}` — diff, not full state (see contract) |
| `queue:sync` | core→one | `{rev, entries[]}` — full state on connect/resync |
| `playback:state` | core→all | `{entryId, positionSec, isPlaying, rev}` |
| `nowplaying:changed` | core→all | `{current, upNext}` — `upNext` drives TV preload |
| `media:status` | core→all | `{mediaId, status, pct, etaSec}` — live processing bar |
| `singer:joined` | core→all | `{singer}` |
| `player:command` | phone→core | `{cmd: play\|pause\|skip\|seek\|restart, ...}` |
| `tv:telemetry` | tv→core | `{positionSec, status, bufferedNextPct}` |
| `op:reject` | core→one | `{clientOpId, reason}` — optimistic rollback trigger |

Reconciliation/diff contract: `/local/home/angryang/.meshclaw/workspace/karaoke-design/reconciliation-contract.md`

---

## 4. Rotation engine (the differentiator)

**Round-robin by singer, not FIFO.** Everyone's 1st pick plays before anyone's 2nd. New
joiner slots into the next gap. `rotationSeq` is the fairness position. This single rule is why
a real party feels fair, and it's where every incumbent is clunky.

**Held-slot rule** (when a `processing` song reaches the front but isn't ready): mark it
`waiting`, advance to the next singer, keep its `rotationSeq` so it slots back at the *same*
fairness position once ready. TV shows `Maya's song is still cooking 🔥 — up next: Sam`.

---

## 5. Data model (MVP)

| Entity | Fields |
|---|---|
| `Room` | id, code, createdAt — one room for MVP |
| `Singer` | id, displayName, color, sessionToken, joinedAt — ephemeral, cookie-backed |
| `Media` | id, source `youtube\|local`, sourceRef, title, artist, durationSec, thumbnail, **stemStatus** `none\|queued\|ready`, **playMode** `iframe\|file` |
| `QueueEntry` | id (client-ULID), mediaId, singerId, status `queued\|playing\|waiting\|done\|skipped`, rotationSeq, addedAt |
| `PlaybackState` | currentEntryId, positionSec, isPlaying — RAM-authoritative, write-behind to SQLite |
| `Job` | id, mediaId, jobType, status, priority, attempts, workerId, stage, progressPct, leaseExpiresAt — see job-lifecycle |

"Users and stuff" for MVP = **ephemeral singers** (name + color + token). Real accounts/history/
favorites are a clean additive layer later — never gate the party behind a login.

---

## 6. Two classes of media (resolves the "1 vs 2 container" tension)

| Class | Examples | Processing | Plays |
|---|---|---|---|
| **Instant** | YouTube iframe, pre-made karaoke file | none | immediately |
| **Processed** | "make karaoke from this song" | worker job | when `ready` (held slot if early) |

100% of MVP is the **Instant** class → zero workers, one container. Worker only ever exists on
the smart-feature path.

**The one decision made:** YouTube plays via **IFrame** in MVP (fast, ToS-clean). Local files and
any make-karaoke song go **download → worker → `<video>` (`playMode: file`)**. A YouTube song
that gets stem-separated just flips `iframe → file`. No rewrite.

Job lifecycle + dial-home worker protocol:
`/local/home/angryang/.meshclaw/workspace/karaoke-design/job-lifecycle-and-worker-protocol.md`

---

## 7. Performance & feel ("wicked fast, a blast")

The three load-bearing wins (full detail in `performance-and-feel.md`):
1. **Optimistic UI everywhere** — client-generated ULID, instant local render, reconcile on
   broadcast, zero flicker. Reject is the rare exception path.
2. **In-memory authoritative state** — queue + playback live in RAM; SQLite is write-behind.
   Broadcasts are sub-ms; reads never touch disk.
3. **Gapless next-song preload** — TV buffers `upNext` while current plays → no dead air. The
   single biggest "blast" multiplier.

Plus: diff broadcasts (not full state), mind-reading search (debounce + cancel + cache), WS
resilience (heartbeat + reconnect + resync), SvelteKit+PWA, 60fps transform/opacity motion +
haptics, almost no spinners.

TV gapless state machine:
`/local/home/angryang/.meshclaw/workspace/karaoke-design/tv-preload-state-machine.md`

---

## 8. Roadmap

1. **MVP** — Instant media only. Nail the two-surface realtime loop + rotation + gapless flow.
   One container. *Ship this first; the unglamorous engine is what everyone gets wrong.*
2. **Smart feature** — dial-home worker, Demucs stems, `playMode` flip, live `media:status` bar,
   `+key/−key`. +1 container.
3. **Scoring** — WhisperX-aligned lyrics overlay + pitch scoring; another TV overlay +
   `score:update` WS event computed server-side from the stems the worker already produced.
4. **Accounts** — additive layer over ephemeral singers (history, favorites, saved karaoke).

---

## 9. Open decisions (not yet locked)
- Lyric-sync UX: auto-generate then human-nudge timing (sung vocals are messy for ASR).
- Crossfade vs hard-cut on gapless transition (default: hard-cut, crossfade as polish).
- Object-store cutover threshold (when does local volume stop being enough).

## Design doc index
- `MASTER-DESIGN.md` *(this file)*
- `job-lifecycle-and-worker-protocol.md`
- `performance-and-feel.md`
- `reconciliation-contract.md`
- `tv-preload-state-machine.md`
- `phone-ui-mock.html`
