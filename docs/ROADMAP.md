# 🎤 Encore — Build Roadmap (commit-level)

Status: **LIVING** · the ordered path from scaffold → MVP → smart feature → scoring → accounts.

## How to read this
- Each line is **one commit** — small, shippable, and green before the next starts.
- **Done-when** is the merge gate (a test, a verified behavior, or an eyes-on).
- **WIP = 1.** Finish a commit (build + its done-when) before starting the next.
- `[ ]` todo · `[~]` in progress · `[x]` done.
- **★ = critical path.** **⚠ = de-risk / decision gate.**
- Test discipline: `packages/shared` + `src/server` logic → `bun test` units; UI → component
  tests + eyes-on screenshot; full flows → Playwright e2e. Mirror VROOM: nothing "done" on a
  passing-text assertion alone — eyes-on any rendered surface.

Milestones map to `docs/MASTER-DESIGN.md` §8. Scaffold (M0-C0) is already committed (`9858d05`).

---

## M0 — Foundation & de-risk  → *ships: the stack proven end-to-end*

- [x] **M0-C0** ★ scaffold monorepo (Bun + shared contract + Bun.serve WS hub) — *done `9858d05`*
- [x] **M0-C1** ⚠★ `svelte-adapter-bun` smoke test — **PASSED**. SvelteKit 2.68 + Svelte 5.56 +
  Vite 8 scaffolded into `apps/core`; `svelte-adapter-bun@1.0.1` prod build serves under Bun on
  aarch64 (HTTP 200, SSR'd). **No adapter-node fallback needed.** Findings: (1) repo-local
  `.npmrc` → public npm (personal project, not CodeArtifact); (2) scripts MUST use `bun --bun`
  or Bun defers to Node 18 and Vite 8 breaks. *UI work unblocked.*
- [x] **M0-C2** ★ unify the process — `server.ts` imports the adapter's `getHandler().fetch`,
  intercepts `/ws` (native pub/sub) + `/health`, falls through to SvelteKit. **Verified:** one
  Bun process served `/` (SSR), `/health`, and a WS round-trip on one port.
- [x] **M0-C3** Drizzle schema + `bun:sqlite` (WAL) for all 6 entities + migration
  `0000_chubby_maestro` + programmatic `runMigrations`/`hydrate` boot helpers. **Verified:**
  `bun test` migrates a `:memory:` db and round-trips every table (2 pass, 9 asserts).
- [x] **M0-C4** ★ shared-contract unit tests — **20 pass / 26 asserts**. `applyOp` (add-in-place
  reconcile, idempotent unknown-id, purity) + `inverseOp` (round-trip restore) + `rotate`/
  `assignSeqs` (3-singer interleave, next-gap join) + `ulid` (sortable/unique). Fairness test is
  NON-VACUOUS (explicitly asserts round-robin ≠ FIFO).
- [x] **M0-C5** design tokens → `app.css` (palette/radii/gradient ported from mock) + `.app-shell`
  (mobile-first, dvh, safe-area insets) + primitives (`.card`/`.btn-accent`/`.pop-in`). **Eyes-on
  confirmed** at 390x844: gradient wordmark, dark radial bg, token swatches all match the mock
  (docs/mocks/m0c5-shell-eyeson.png). svelte-check 0 errors.
- [x] **M0-C6** PWA: `manifest.webmanifest` (standalone, 192+512 maskable icons, theme color) +
  `src/service-worker.ts` (precache build+files via `$service-worker`; network-first nav,
  cache-first hashed assets; skips /ws + /api) + app.html links. **Verified:** manifest
  (application/manifest+json), SW, both icons all serve HTTP 200; page links manifest+theme-color.
  *(Lighthouse not installed here — verified each installability criterion directly.)*

---

## M1 — The realtime spine  → *ships: two browsers, one synced queue (no media yet)*
*The engine every incumbent gets wrong. Build it before any feature.*

- [x] **M1-C1** ★ in-memory authoritative state (`src/server/state`): `AuthoritativeState` holds
  queue+playback in RAM, monotonic `rev`, server-owned `assignSeqs` on every mutation, debounced
  write-behind via `sqlitePersistence`, `hydrate()` on boot, defensive-copy getters. **Verified:**
  5 tests — rev bumps, fair re-seq, no external mutation, **reload-from-db == memory**, debounce coalesce.
- [x] **M1-C2** ★ rotation server module (`src/server/rotation`): `reseq` (server-owned fair
  order), `nextPlayable` (held-slot rule: skip cooking media, keep its seq), `upNextAfter` (TV
  preload target), `isEntryReady` (iframe always / file when stems ready). **Verified:** 6 tests —
  3-singer interleave, next-gap join, **held-slot skip+restore**, ready-gating. (Held-slot seam
  de-risks M5/M7 early.)
- [x] **M1-C3** ★ WS hub (`src/server/realtime/hub.ts`): `handleQueueCommand` validates →
  `state.applyQueueOp` → broadcasts `queue:patch{rev,ops,causedBy}` + `queue:sync{rev,entries}`
  (clients adopt server seqs). Decoupled from `Bun.serve` via injected `publish` sink (unit-
  testable, no socket). **Verified:** 3 tests — patch envelope + rev + causedBy, rev advances, state applied.
- [x] **M1-C4** `op:reject` path: invalid command → targeted reject to originator only (via
  `sendToOrigin` sink), no room broadcast, rev unchanged. **Verified:** 5 tests — unknown media,
  unknown entry (remove/move/status), precise reasons, no-sink case stays silent.
- [x] **M1-C5** ★ client ws (`src/lib/ws/client.ts`): `WsClient` — connect, heartbeat (hello as
  ping), capped-backoff reconnect, `hello{lastRev}`→`queue:sync` resync, gap-detection (rev-skip →
  resync, don't apply). Injectable socket factory + timers for deterministic tests. **Verified:**
  6 tests — **kill+restore reconnects & resyncs rev 5→9**, gap→resync, contiguous apply, no-reconnect-on-close.
- [x] **M1-C6** ★ optimistic queue store (`src/lib/stores/queue.ts`): `QueueStore` — client-minted
  ULID, instant local `applyOp`, `pending` map (op+inverse), reconcile-on-`causedBy` (zero
  duplicate, adopt server seq), rollback-on-`op:reject` via inverse, **rebase pending on resync**.
  Framework-agnostic (subscribe hook) for DOM-free tests. **Verified:** 6 tests cover all five paths.
- [x] **M1-C7** dev harness (`/harness` two-iframe + `/harness/phone`) — **integration moment**:
  wired state+hub into live `Bun.serve` WS (hello→`syncEvent`, queue:command→`handleQueueCommand`),
  seeded demo media catalog. **Verified:** real two-client WS test (Maya add → Sam sees it) +
  **eyes-on both panes show `#0 demo-takeonme (maya)` rev=1** (docs/mocks/m1c7-sync-eyeson.png).
  **M1 milestone COMPLETE — the realtime spine is live end-to-end.**

---

## M2 — Join & identity  → *ships: scan QR → you're in*

- [x] **M2-C1** singer session: `SingerRepository` (create/bySessionToken/byId) + `randomBytes`
  base64url token + cookie helpers (`sessionCookie` HttpOnly/SameSite=Lax/Secure, `readSessionToken`).
  Name sanitize (Guest fallback, 32-char cap). **Verified:** 7 tests — create→token→resolve,
  unknown→null, unique tokens, cookie round-trip.
- [x] **M2-C2** `POST /api/join` + `SINGER_COLORS` palette (shared) + **app singleton** (`$server/app`,
  the SvelteKit↔WS-hub seam; `setPublish` routes broadcasts through Bun pub/sub). **Verified:** unit
  (doJoin: create+singer:joined+color-fallback+blank-reject, 3) AND **live HTTP**: join→200+HttpOnly
  cookie+singer JSON (no token leak), blank→400. (`bun:sqlite` adapter warning is cosmetic — Bun resolves natively.)
- [x] **M2-C3** `/join` page: name field + 8-swatch avatar-color grid (shared `SINGER_COLORS`),
  no signup wall, disabled-until-named button. **Verified:** eyes-on 390x844 (docs/mocks/m2c3-join-eyeson.png)
  + live flow drive: fill→pick→Start → lands on `/` with `encore_singer` session cookie set.
  (Also fixed 2 pre-existing strict-type nits surfaced by check: WsClient `ResolvedOptions`, state.test copy.)
- [x] **M2-C4** TV `/tv` attract: server-rendered join QR (qrcode lib, origin/join), "Scan to
  join" hero, live WS connection dot, "Up next" ticker (live from queue:sync), breathing QR motion.
  **Eyes-on confirmed** 1280x720 (docs/mocks/m2c4-tv-eyeson.png). **M2 milestone COMPLETE.**

---

## M3 — Phone remote (the star)  → *ships: the mock, made real & live*

- [x] **M3-C1** ★ ported `SongCard`, `QueueRow` (mine/up/pending states), `ProcessingCard` (live
  bar + stage chips), `NowPlaying` (greyed key-shift) to `$lib/components` + `/components` gallery.
  **Eyes-on confirmed** 390x900 — all four match the mock (docs/mocks/m3c1-components-eyeson.png). svelte-check 0/0.
- [x] **M3-C2** ★ phone `+page.svelte` wired to `QueueStore` + `WsClient` live: `/api/me` (redirect
  to /join if not joined), `queue:sync` carries singer+media directories (extended event), rotation
  renders via `QueueRow` with computed position label. **Eyes-on + live flow**: join→add→`#1 Take On
  Me — a-ha · You · up next`, label **"You're up next! 🎤"** from shared rotation (docs/mocks/m3c2-phone-eyeson.png).
- [x] **M3-C3** ★ optimistic add: tap ＋Turn → instant row + `navigator.vibrate(8)` haptic →
  reconcile. **Verified (DOM e2e):** added 3 songs; **optimistic order === settled order
  byte-identical** after all server echoes (3 rows, 0 dup, no reorder) — client-minted-ULID
  zero-flicker reconcile proven on a real page.
- [x] **M3-C4** remove (✕ on mine, not up-next) → `store.removeEntry` (optimistic) + 5s undo toast
  that re-adds. **Verified (e2e):** 2 rows → remove btn only on row 2 → removed (2→1) → toast shown →
  **undo re-adds (1→2)**. (Swipe gesture deferred to touch-polish; button is the reliable affordance.)
- [x] **M3-C5** reorder *your own* entries via ↑/↓ (move op → server `#reorderWithinSinger` permutes
  addedAt among that singer's picks; `assignSeqs` re-derives, other singers' slots untouched).
  **Verified:** 4 unit tests (within-singer swap, others undisturbed, clamp, unknown no-op) + e2e
  (Dancing Queen idx 2→1, canonical order persists). (Tap ↑/↓ = reliable a11y affordance; drag deferred.)
- [x] **M3-C6** now-playing strip → `player:command`. Server `handlePlayerCommand` (play starts
  first playable, pause/seek/restart/skip mutate `PlaybackState` → broadcast `playback:state`).
  Strip shows on current entry, reflects state. **Verified:** 5 unit + e2e (strip 0→1 on play,
  'Take On Me' + ⏸, tap → pause → ▶). (No UI Start button yet — M5/TV owns starting playback.)
- [x] **M3-C7** 60fps motion pass: audited all animations → transform/opacity/background only;
  fixed ProcessingCard bar (`width` → `transform:scaleX`, GPU-composited). Source-scan guard
  (motion.test) asserts no transition/keyframe touches a layout prop — **non-vacuous** (injecting
  `transition:width` fails it). **M3 milestone COMPLETE** — phone remote is live & smooth.

---

## M4 — Search & media resolve  → *ships: find a song, queue it*

- [x] **M4-C1** ★ `MediaResolver` iface + `resultToMedia` (local→file, youtube→iframe) + `LocalLibrary`
  (SQLite **FTS5** virtual table, bm25 ranking, prefix match over title/artist). **Verified:** 6 tests —
  title/artist match ('queen'→3 ranked), prefix, limit, empty, local→playMode:file.
- [x] **M4-C2** ★ `YouTubeResolver`: query cache (TTL) + in-flight dedupe (keystroke bursts → one
  backend call) + blank guard; injectable backend (unit-testable). **Verified:** 5 tests — 2nd query
  from cache, limit=key, TTL expiry, concurrent dedupe to 1 call, blank no-call.
- [x] **M4-C3** yt-dlp backend (**keyless** `ytsearchN:` via `Bun.spawn`, default per 2026-06-29) +
  `parseSearchJson` + per-video-id meta cache + **graceful degrade** (returns `[]` not throw when
  binary absent — confirmed live in dev). **Verified:** 5 tests (parse/round/fallbacks, cache, degrade).
- [x] **M4-C4** ★ search UI: unified bar + YouTube/Library tabs, **debounce 150ms** + **AbortController
  cancel-in-flight** per keystroke; `/api/search` materializes results → queue-able Media in the
  catalog. **Eyes-on + e2e**: Library "queen" → "Bohemian Rhapsody ✨" → add → #1 in rotation
  (docs/mocks/m4c4-search-eyeson.png). **Caught+fixed a real bug:** SvelteKit handler is a separate
  bundle → `getApp()` was split-brain; backed singleton on `globalThis` (one shared instance).
- [x] **M4-C5** zero-keystroke shortcuts: `PopularityTracker` (recordAdd on queue; recent by time,
  popular by count+recency tie-break) → `/api/search?q=` returns recent+popular → phone shows
  "🔥 Popular tonight" + "🕑 Recently queued" when box empty. **Eyes-on confirmed** (Sweet Caroline
  in both sections, docs/mocks/m4c5-shortcuts-eyeson.png) — 5 unit tests. **M4 milestone COMPLETE.**

---

## M5 — Playback & gapless TV  → *ships: songs actually play, with zero dead air* ★★

- [x] **M5-C1** ★ player state machine: `handleTelemetry` advances on `tv:telemetry` ended
  (mark done → `nextPlayable` held-slot-aware → status playing → broadcast), `emitNowPlaying`
  publishes `nowplaying:changed{current, upNext}` (upNext = `upNextAfter`, drives TV preload),
  position-only telemetry tracks without churn. **Verified:** 5 tests — ended-advances-by-seq,
  last→attract, upNext carried, position-only, **held-slot skip**. Wired into server WS.
- [x] **M5-C2** ★ `TvPlayer.svelte` abstracts `playMode`: `iframe` (YouTube embed, autoplay/mute
  by active+visible) + `file` (`<video>` preload=auto, play/pause synced). **Eyes-on:** real
  "a-ha — Take On Me" YouTube embed playing on `/tv` (docs/mocks/m5c3-tv-eyeson.png).
- [x] **M5-C3** ★★ two-player gapless preload (`$lib/tv/gapless.ts` `GaplessController`): A visible /
  B hidden-warming, swap-on-ended when hidden is pre-buffered (→ interstitial, no reload), missed-
  window fallback to loading, re-warm on reorder, A↔B alternation. **Verified:** 7 unit tests (incl.
  the gapless-swap proof) + eyes-on (attract→playing, lower-third). Crossfade = opacity-only.
- [x] **M5-C4** interstitial "Next up: NAME — SONG" overlay + `Now singing` lower-third, duration
  **env-configurable** (`INTERSTITIAL_MS`, 0 = pure gapless hard-cut). Verified via gapless unit
  tests (interstitial→playing) + eyes-on lower-third.
- [x] **M5-C5** ATTRACT (join QR + ticker) / LOADING / WAITING ("🔥 Still cooking") states wired to
  `GaplessController`; held-slot guard shows WAITING for a not-ready file current (M7 path).
  **Verified:** eyes-on attract↔playing transition; states typecheck + build clean.
- [x] **M5-C6** TV reconnect resilience: capped-backoff auto-reconnect; video/iframe plays
  independently of the socket so a drop never stops playback. **Caught+fixed a real bug:** `hello`
  now replays queue **+ playback:state + nowplaying** so a reconnecting client resumes the live song.
  **Verified:** full reload mid-song → resyncs (playing=1, connected=1). **M5 milestone COMPLETE ★★.**

---

## M6 — MVP hardening & ship  → *ships: `docker compose up`, a real party* ★

- [x] **M6-C1** thumbnail proxy `/api/thumb?u=` → `serveThumb` (disk cache under `.thumbs`,
  fetch-once then HIT from disk, `cache-control: immutable 30d`, x-cache HIT/MISS, url-hash keys
  prevent traversal). **Verified:** 5 tests (stable safe keys, ext preserve, content-type, path).
- [x] **M6-C2** WS resilience: server **idempotency ledger** (bounded `seenOps` Set; resent
  clientOpId re-acks not re-applies), client `resendPending()` on resync (same clientOpIds →
  server dedupes), capped backoff (WsClient). **Verified:** 3 dedupe tests (no double-apply, re-ack
  causedBy, distinct ids apply) + resend test (same-id replay).
- [x] **M6-C3** ★ full-flow e2e (`e2e/party.mjs`, 2 phones + TV): **7/7 green** — two joins, Library
  search returns results, both phones see identical round-robin order (cross-client sync), TV
  now-singing lower-third on play, skip advances to a different singer's song (Maya→Sam "Don't
  Stop Believin'", docs/mocks/m6c3-party-eyeson.png).
- [x] **M6-C4** ★ `apps/core/Dockerfile` (multi-stage `FROM oven/bun:1.3`, build SvelteKit + bundle
  **yt-dlp 2026.06.09 + ffmpeg 7.1.5**) + `.dockerignore` + compose (root context). **Verified live:**
  image builds, container runs, `/health` ok + `/` SSR HTTP 200, both media tools present. Fixed a
  real runtime bug: workspace `@encore/shared` symlink → re-`bun install` in runtime stage relinks it.
  (`docker compose` binary absent in this env; validated via `docker run` + compose config inspection.)
- [x] **M6-C5** edge states: empty queue → attract/empty copy; no search results → explanatory
  copy; **dead video → `onerror`→skip** (room advances, never hangs on black); rejected op +
  search failure → **error toast** (+ optimistic rollback). **Verified (e2e):** offline search →
  "Search failed — check your connection" toast. 96 tests green.
- [x] **M6-C6** README rewritten: feature list, phone+TV screenshots, Docker + Bun quickstart,
  env config table, status/roadmap. Tagged **v0.1.0 (MVP)**. **M6 milestone COMPLETE — MVP SHIPPED.**

---

## M7 — Smart feature: make-karaoke (container 2)  → *ships: drop a song → stems* ★

- [x] **M7-C1** ★ job ledger (`src/server/jobs`): pure state machine (`transitions.ts`,
  queued→assigned→running→ready/failed/canceled, terminal-escape + skip rejected) split from the
  I/O `JobRepository` (`repository.ts`); migration `0002` adds the `error` column + a **partial
  unique index** `jobs_live_media_type_idx` on `(media_id, job_type) WHERE status NOT IN
  ('failed','canceled')` so the DB itself enforces dedup (terminal jobs free the slot → re-process).
  **Verified:** 15 unit tests — full lifecycle, idempotent re-add (reuses the live job), per-key
  dedup, slot-freed-on-terminal re-add, **DB index rejects a race-inserted dup**, requeue clears
  owner/lease, illegal-transition + unknown-id throws. Core suite 117→132 pass, svelte-check 0/0.
- [x] **M7-C2** ★ leases + reaper (ack 10s / progress 30s), boot resets assigned/running→queued.
  Pure lease policy (`leases.ts`: `ackDeadline`/`progressDeadline`, `sweep` → requeue/fail actions,
  `inflightToRecover`) split from the I/O `JobReaper` (`reaper.ts`: `tick`/`recoverOnBoot`/`start`/
  `stop` over the repo). Ack-timeout requeues with **no attempt burned**; progress-lease expiry does
  `attempts++` → requeue, or **fail** when exhausted (records the dying attempt + error). `accept`
  now stamps a fresh progress lease (caught: a near-ack-deadline accept would've been instantly
  reaped). Wired: `getApp()` runs `recoverOnBoot()` one-shot; `server.ts` calls `reaper.start()`.
  **Verified:** 14 unit tests (ack-timeout no-burn, progress-lease requeue, heartbeat refreshes
  lease, exhaustion→failed, boot recovery preserves attempts, onReaped fires only on change) +
  boot smoke (/health ok, reaper started, no crash). Core 132→145 pass, build green, svelte-check 0/0.
- [x] **M7-C3** ★ dial-home worker protocol on core: shared wire types (`WorkerMessage`/
  `WorkerCommand`/`JobArtifacts`); in-memory `WorkerRegistry` (never persisted, §10 — hello/
  heartbeat/slot accounting/reconnect-replace); pure `dispatch.ts` (`planAssignments` — need-order
  priority=rotationSeq ASC + createdAt tiebreak, least-loaded eligible worker, capability match,
  capacity-per-pass); I/O `WorkerHub` (`worker-hub.ts`) routing `worker:hello`→welcome+dispatch,
  `job:accept/reject/progress/complete/failed` through the ledger + leases, rebroadcasting
  `media:status` for the live phone bar; flips media `stemStatus→ready` on complete. Wired into
  `app.ts` (hub + registry on EncoreApp; reaper `onReaped`→redispatch) and `server.ts` (role=worker
  WS family → `workerHub.handle`, socket map for `toWorker`, disconnect deregisters → reaper
  reclaims via lease). **Verified:** 28 unit tests (registry 6, dispatch 8, worker-hub 8 incl. full
  hello→accept→progress→**complete→ready**, reject/retry/terminal-fail, need-ordered dispatch,
  stale-worker guards) + **live WS smoke** (real worker socket drove a job to ready, media flipped).
  Core 145→167 pass, prod build green, svelte-check 0/0.
- [x] **M7-C4** ★ worker container: full dial-home loop. Pure `protocol.py` (message builders,
  `WorkerState` capacity/capability gating, per-job-type stage plans) + pluggable `processor.py`
  (`Processor` seam; `StubProcessor` walks the stage plan + writes a placeholder instrumental —
  real Demucs swaps in at M7-C5 behind the same async-generator interface) + I/O `dial_home.py`
  (`WorkerClient`: hello→welcome→assign→accept→progress*→complete, capacity-reject, cancel,
  failure-with-retryable-flag, reconnect+backoff; processing runs as a concurrent task so ping/
  cancel stay responsive). `apps/worker/Dockerfile` (python:3.12-slim + ffmpeg + pinned torch/
  demucs, non-root uid 10001, writable model cache) + `requirements.txt`. **Verified:** 14 pytest
  (protocol 5, dial-home 9 incl. full assign→complete + artifact written, capability/slot reject,
  retryable vs permanent failure, ping→heartbeat, cancel) + **LIVE end-to-end**: the REAL
  `python -m src.dial_home` dialed a real `bun` core — registry went 0→1 worker, seeded job drove
  queued→ready (pct 100), media flipped stemStatus→ready, instrumental written to the volume.
  Core 167 / shared 25 / worker 14 all green; svelte-check 0/0.
- [x] **M7-C5** ★ Demucs `htdemucs` stems pipeline → instrumental written to MediaStore.
  `demucs.py`: PURE helpers (yt-dlp/demucs argv builders, `--two-stems=vocals` → `no_vocals.wav`
  path resolver, yt-dlp + tqdm progress parsers, permanent-vs-transient `classify_retryable` +
  structured `ProcessError`) split from the I/O `DemucsProcessor` (download→separate→publish via an
  INJECTABLE async runner; emits downloading→separating progress; local sources skip download).
  Wired into `dial_home.py` as the env-selectable default (`ENCORE_PROCESSOR=demucs|stub`); the
  failure path now honors `ProcessError.retryable`. **Verified (no-ML):** 14 pytest drive the full
  download→separate→publish flow with a fake runner (canned CLI output, files faked) — youtube +
  local-source paths, progress ramping, missing-output guard, retryable vs non-retryable failures;
  worker suite 14→28, core 167 / shared 25 green. **REAL-ML VERIFIED (2026-06-30, aarch64/CPU):**
  built the worker image and ran the REAL `DemucsProcessor` on a 12s clip — htdemucs wrote both
  `vocals.wav` and the instrumental (`clip-instrumental.wav`), acoustically distinct from the source
  (diff-signal RMS 85.6 vs src 1448 → genuine separation, not a passthrough). The build surfaced +
  fixed a real reproducibility bug: an unpinned `torchaudio` resolves to an ABI-incompatible wheel
  (`undefined symbol aoti_torch_abi_version`) → torchaudio pinned to torch's exact minor. Re-verified
  on the C8 coupled bump: htdemucs still separates on **torch 2.8** (diff-RMS 125.9). Done-when met.
- [x] **M7-C6** ★ `playMode` flip iframe→file on `ready`; rotation **held-slot** real impl
  (keep seq, slot back when ready). `make-karaoke.ts`: `requestMakeKaraoke` flips a media to a
  cooking `file` (so rotation's `isEntryReady` auto-holds its slot) + enqueues a stems job at
  need-priority (`soonestSeqFor`), idempotent + refuses the currently-playing song; `markMediaReady`
  flips to the instrumental (`playMode:file`, `sourceRef:stems/<id>-instrumental.wav`, stems ready).
  worker-hub `#onComplete` now calls `markMediaReady` + fires `onMediaReady`; player
  `reconcileOnReady` starts the freshly-ready song if the room idled while cooking (else re-emits
  nowplaying so the TV preloads it) — the held entry plays at its preserved seq. New
  `POST /api/make-karaoke` (joined-singer gated). **Verified:** 17 unit tests (make-karaoke 7 incl.
  the cook→held→ready→plays-at-slot round trip, reconcileOnReady 2, worker-hub flip+onMediaReady) +
  **LIVE integration**: real core, HTTP join, WS queue, `/api/make-karaoke`, real worker drove the
  job to ready → the held song played at its fair slot (current=the cooked song, upNext intact).
  Core 167→177 pass, prod build green, svelte-check 0/0.
- [x] **M7-C7** ★ live progress UI: `media:status` → `ProcessingCard` bar (`Separating… 68%`) +
  stage chips. Phone page tracks a `mediaStatus` map from `media:status` broadcasts; a cooking
  queued entry renders `ProcessingCard` (bar + stage chips) instead of `QueueRow`; `SongCard` gains
  an optional `✨ Karaoke` button → `POST /api/make-karaoke` (optimistic "queued" bar while the
  request lands). **Done-when met — eyes-on confirmed:** drove the live phone in a real browser
  (join → queue Bohemian Rhapsody → ✨ Karaoke → worker emits separating 68%); the ProcessingCard
  rendered with the gradient bar at 68%, "Separating vocals…" label, and ✓Queued/✓Downloaded/
  ●Separating/Ready chips (docs/mocks/m7c7-processing-eyeson.png). Core 177 pass, build green,
  svelte-check 0/0.
- [x] **M7-C8** ★ HYBRID word-timed lyrics: LRCLIB known text + WhisperX **forced-alignment**
  (not ASR-transcribe — feeding WhisperX correct human-authored lyrics + audio and using its
  wav2vec2 `align()` to place WORD timings is far more robust than transcribing sung vocals).
  `lyrics_source.py`: LRCLIB client (free no-auth synced-lyrics DB) behind an INJECTABLE fetcher +
  PURE LRC parser (multi-timestamp, fraction forms, `[offset:]`, metadata skip) + segment builders
  + line-synced artifact shape (15 tests). `whisperx.py` rewritten to the hybrid: fetch source →
  LRCLIB → `Aligner` seam (`WhisperxForcedAligner` = real `load_align_model`+`align`, injectable
  fake in tests) → word-timed artifact, with **graceful fallback to LRCLIB line-sync** if the
  aligner is unavailable/errors (feature always ships lyrics). Coupled version-set bumped together
  (Stage 1): `torch 2.8 + torchaudio 2.8 + torchvision 0.23 + demucs 4.0.1 + whisperx 3.8.6`
  (numpy 2.5, faster-whisper 1.2) — the only combo that installs on py3.12/aarch64; the old 3.1.1
  pin was a dead end (its faster-whisper 0.10.x has no cp312 wheel; ≥1.0 breaks its
  TranscriptionOptions API). **Verified:** worker 41→70 pytest (LRCLIB parse/segment/client 15 +
  hybrid flow with fake LRCLIB+fake aligner: download→align→word-timed, aligner-failure→line-sync
  fallback, instrumental/no-lyrics/missing-params guards) + **REAL-ML (2026-07-01, aarch64/CPU):**
  the real `WhisperxForcedAligner` ran `whisperx.align` on wav2vec2 (360MB model) through the real
  `WhisperXProcessor` against known text + a speech clip → **9 monotonic word timings on the exact
  provided text** (`the`[0.32] `quick`[0.41] `brown`[0.66] `fox`[1.09] …). Core 196 / shared 30 green.
- [x] **M7-C9** `+key/−key` pitch shift (ffmpeg/rubberband on the instrumental). Shared:
  `PlaybackState.keyShift` (semitones) + `clampKeyShift`/`keyedMediaRef` (signed variant before the
  ext, e.g. `m1-instrumental.+2.wav`) + `MAX_KEY_SHIFT=7`; `PlayerCommand` += `{cmd:'key',semitones}`
  (absolute target). Core: player `key` handler transposes ONLY a ready `file` current (clamped,
  no-op on iframe/not-ready), resets to 0 on every song change; schema migration 0003 + persistence/
  hydrate; TvPlayer resolves the keyed instrumental. Phone: NowPlaying strip enabled for a ready
  file song — shows "Key · +N", −/＋ buttons send the command. Worker `pitch.py` (PURE): semitone→
  ratio math, ffmpeg asetrate→aresample→atempo chain (rubberband variant), keyed paths, pre-render
  variant set. **Done-when MET — eyes-on confirmed:** drove the live phone (join → queue → ✨ Karaoke
  → worker completes → song plays as ready file → tap ＋ semitone ×2); the strip shows **KEY · +2** in
  amber with active −/＋ controls (docs/mocks/m7c9-keyshift-eyeson.png). Core 177→182, shared 25→30,
  worker 41→47 pass; svelte-check 0/0; build green. **RENDER REAL-VERIFIED (2026-06-30):** ran the
  REAL `pitch.shift_argv()` chain through full ffmpeg (in the worker base image, apt ffmpeg) on a
  440Hz tone → **659.3Hz** output (exactly 440×2^(7/12), a perfect fifth) with duration preserved
  2.00→1.99s — pitch shifted, tempo intact. (Host ffmpeg is the stripped 16-filter build; the
  container's apt ffmpeg has atempo/asetrate.) Done-when fully closed.
- [x] **M7-C10** MediaStore `object` impl (MinIO/S3) for remote workers + env flip. Shared
  `MediaStoreConfig` union (local | object{bucket,endpoint,region,prefix}) now types `worker:welcome`.
  Core `media/store.ts`: PURE `resolveMediaStoreConfig` (env→config, object-without-bucket falls back
  to local so the party always runs) + `normalizePrefix`/`objectKey`/`mediaProxyUrl` helpers +
  `MediaStore` iface + `LocalMediaStore` (wraps safeMediaPath/Bun.file). `media/object-store.ts`:
  `ObjectMediaStore` on Bun's native S3 (Bun.S3Client — no aws-sdk/minio dep; MinIO via custom
  endpoint) behind an injectable `S3Like` seam; `url()` presigns a direct URL by default (bytes skip
  the core) or proxies same-origin for a private bucket. Env-flip in app.ts (lazy S3 client); the
  `/media` route now streams through the store; worker `mediastore.py` (PURE) parses the welcome
  config + builds a local-no-op/object-upload publisher. **Done-when MET:** integration test drives
  the second-box round trip — a remote worker publishes stems to a shared (fake-S3) bucket, the core
  reads them back via the SAME prefixed key + presigns the TV URL; plus a LIVE env-flip boot probe
  (MEDIA_STORE=object → kind:object with the resolved config; default → local, url→/media). Core
  182→196, shared 30, worker 47→53 pass; svelte-check 0/0. **PRESIGN REAL-VERIFIED (2026-06-30):**
  ran the REAL `ObjectMediaStore`+`bunS3Client` against a live MinIO (S3 API) — put/get/exists
  round-trip + a genuine SigV4 presigned URL that **fetched back over HTTP 200 with matching bytes**
  (the exact path a credential-less probe couldn't reach). Done-when fully closed.
- [x] **M7-C11** tag **v0.2.0 (stems)**. Every stems/lyrics sub-task (C1–C10) real-ML verified
  against actual binaries before the tag — Demucs `htdemucs` two-stem (torch 2.8, diff-RMS 125.9),
  WhisperX wav2vec2 forced-alignment on LRCLIB text (9 monotonic word timings), ffmpeg ±key pitch
  (440→659 Hz), and a live MinIO SigV4 presign (HTTP 200, matching bytes). Annotated tag authored
  `OnlyOneByte`, mirroring v0.1.0. **M7 milestone COMPLETE — make-karaoke/stems SHIPPED (v0.2.0).**

---

## M8 — Scoring  → *ships: SingStar-style scoring*

- [x] **M8-C0** worker publishes the isolated **vocals stem** (`artifacts.stems.vocals`). Shared
  prerequisite of pitch extraction (C1) and the vocal-guide mix (`docs/vocal-guide-spec.md`).
  **Done-when:** unit — `CompleteResult` carries a `vocals` key at the deterministic path. — *DONE:
  `demucs.py` now moves `vocals.wav` to `stems/<mediaId>-vocals.wav` and includes it in the artifact
  (was separated by `--two-stems=vocals` then discarded). BEST-EFFORT: a missing vocals file never
  fails the load-bearing instrumental. Added `processor.vocals_path` + `demucs.demucs_vocals_path`;
  13 demucs tests (happy-path publishes both stems + best-effort vocals-absent). Core-side
  `Media.vocalsRef` wiring is M8-C5 (vocal guide).*
- [x] **M8-C1** pitch extraction from the isolated vocal stem (per-frame f0). **Done-when:** unit
  test: known tone → expected pitch track. — *DONE: `apps/worker/src/pitch_track.py`, a pure-numpy
  autocorrelation f0 tracker (framed ACF + parabolic-interp lag refine + RMS/periodicity voicing
  gates, Hz↔MIDI, stdlib `wave` reader — no torch/scipy). Verified in-sandbox: synthesized A440→440,
  A2/A3/E4/C5 within a quarter-tone, 220↔440 jump tracked, silence→unvoiced, WAV round-trip (12
  tests). Consumes the isolated vocal stem now published by M8-C0.*
- [x] **M8-C2** aligned lyrics overlay on TV (bouncing-ball from WhisperX timings). **Done-when:**
  eyes-on: words highlight in time. — *DONE: `LyricsOverlay.svelte` on `/tv` fetches the word-timed
  artifact (M7-C8) via the current media's new `Media.lyricsRef` (worker-hub `#onComplete` now
  threads `artifacts.lyrics.uri` through `setMediaLyrics`), rAF-interpolates the player position for
  a smooth 60fps karaoke sweep, and highlights each word (sung/active-wipe/upcoming) with a bouncing
  ball over the active word; line-sync fallback lights the whole line when a line has no word
  timings. Pure timing logic (`lib/tv/lyrics.ts`: parse + `activeLineIndex`/`activeWordIndex`/
  `wordFill`) unit-tested (7 tests); eyes-on confirmed via the `/components` gallery demo.*
- [x] **M8-C3** live mic pitch compare → `score:update` WS event (computed server-side).
  **Done-when:** eyes-on: score moves with sung pitch; TV overlay + phone reflect it. — *DONE:
  full pipeline. Worker `score` job publishes a reference pitch-track artifact (`Media.pitchRef`);
  phone detects mic f0 client-side (`lib/mic/pitch-detect.ts` normalized-ACF + McLeod peak-pick,
  octave-robust) and streams `mic:pitch`; the core `ScoreEngine` (`realtime/scoring.ts` +
  `scoring/scorer.ts`: octave-agnostic cents → closeness-weighted 0–100 rolling accuracy, rests not
  penalized) broadcasts `score:update`; TV `ScoreBadge` + phone score pill reflect it live. Pure
  logic unit-tested (scorer 6, engine 5, detector 5); eyes-on via the `/components` gallery showing
  the score move 14→45→55 across the pink→blue bands on both surfaces. Real-mic capture is
  device-verified (sandbox has no microphone).*
- [~] **M8-C4** end-of-song score reveal + session leaderboard. **DEFERRED** (2026-09-02, owner
  decision): live scoring already lands on both surfaces (C3), so the reveal + leaderboard is
  presentation polish rather than a missing capability. Moved to *Deferred — future* below; **M8 is
  closed** at C0–C3. The **v0.3.0 (scoring)** tag moves with it.

---

## M8 status

M8 is **CLOSED** with C0–C3 shipped: vocals stem published, reference pitch extracted, word-timed
lyrics overlay on the TV, and live mic→server scoring on both surfaces. C4 (reveal + leaderboard) is
deferred as future work — see *Deferred — future*.

---

## M9 — Accounts (additive, never gates the party)  → *ships: persistence across nights*

- [ ] **M9-C1** real accounts layered over ephemeral singers (OAuth or local). **Done-when:**
  ephemeral singer can "claim" an account; nothing about join flow regresses.
- [ ] **M9-C2** history + favorites + saved-karaoke library. **Done-when:** re-queue a saved
  karaoke instantly (skips the worker). 
- [ ] **M9-C3** multi-room (the deferred scale knob): room codes, per-room topics. **Done-when:**
  two independent rooms run on one core. Tag **v1.0.0**.

---

## Post-v0.2.0 hardening — shipped 2026-09-02 (from live-testing the tunnelled demo)

Bugs found by driving the real app (worker + TV + phone over a Midway tunnel) and fixed +
verified. Not milestone features — recorded so the roadmap reflects reality.

- [x] **H-1** auto-start playback when a song is queued into an idle room — the TV was stuck on
  the attract screen (a plain add never triggered play). `server.ts` calls `reconcileOnReady` after
  a queue add when idle. +`autostart.test.ts` (2). — *`0668f86`*
- [x] **H-2** phone pause/resume actually pauses the TV — the TV ignored `playback:state.isPlaying`;
  `TvPlayer` now honors a `playing` prop. Verified: pause froze `currentTime`, play resumed. — *`0668f86`*
- [x] **H-3** TV shows the real singer name (not "Someone") — TV now handles `singer:joined`. — *`0668f86`*
- [x] **H-4** phone search shows a spinner + skeleton rows while a query is in flight. — *`0668f86`*
- [x] **H-5** persistence by default — file-backed SQLite unless `ENCORE_EPHEMERAL=1`, so singers +
  queue + playback survive restarts/refresh. Verified: session cookie + queue survive a restart. — *`0668f86`*
- [x] **H-6** closed the cook→play gap — on a song flipping ready, broadcast a fresh `queue:sync`
  so clients get the ready media's new instrumental `sourceRef`/status immediately (TV no longer
  sits on WAITING); TV also applies `media:status` live. Verified: cook→play is prompt. — *`9fb2b58`*
- [x] **H-7** seek/scrollbar works — TV seeks the `<video>` on a `playback:state.positionSec` jump.
  Verified: seek→90 moved the video to ~92s. — *`9fb2b58`*

---

## Backlog — auto-cook queue (prioritized)

The remaining features + gaps, ordered for an autonomous build loop. Each carries a **done-when**
and a **verify** method tagged **AUTO** (a machine gate the loop runs) or **EYES-ON/REAL-ML/NET**
(the loop implements + unit-covers, then flags for the human — cannot self-verify here).

**Auto-verification gates (run every item):** `bun test` (from `apps/core`) + `pytest` (from
`apps/worker`) + `bun run typecheck` + `bun run build`. Note: run core tests from `apps/core` (the
monorepo root has a drizzle subpath-resolution quirk).

**Environment ceilings the loop must respect (flag, don't fight):** LRCLIB is DNS-sinkholed on this
corp box (offline lyrics need the transcribe fallback or a deploy box); there is no microphone
(live scoring uses a synthesized pitch stream); Demucs/WhisperX run in the `encore-worker` container
(~1–2 min/song on CPU); YouTube autoplay-with-audio needs a user gesture in-browser.

- [x] **B-1 · Saved-karaoke library + cooked-media persistence** (M9-C2 core) — *done, verified
  end-to-end against a real server restart.* `media` rows are upserted on search-materialize, on the
  make-karaoke request (cooking state), and on the ready flip (via a `persistMedia` seam on the
  worker hub); `getApp()` hydrates the runtime catalog from disk before anything reads it, so titles
  survive a restart and `requestMakeKaraoke` refuses to re-cook stems that already exist
  (`isCooked` / `cookState`). New `GET /api/library` + a phone "🎤 Karaoke library" section for
  one-tap re-queue that skips the worker, and a "✨ Cooking now" section that renders the
  ProcessingCard for a cooking song with no rotation row of its own (`ProcessingCard`'s `seq` and
  singer props are now optional). Migration `0004` adds `lyrics_ref` + `pitch_ref` so a library song
  keeps its lyrics overlay and scoring reference. **Two bugs the restart harness caught that unit
  tests could not:** (1) `server.ts` seeded its demo catalog unconditionally, overwriting a hydrated
  cooked song with a pristine iframe stub — it now seeds only what is missing; (2) the job dedup
  index counts `ready` as live, so `enqueue` can return a finished job — the media is now reconciled
  to it instead of being left `queued` against work that will never run (which held the entry out of
  rotation forever). Also fixed: search/library/shortcut results are merged into the client media
  catalog, or a cooking card rendered a raw ULID instead of the song title.
  **Verified:** AUTO — 14 new unit tests (repository round-trip + hydrate-no-clobber + boot round
  trip; `isCooked`/`cookState`; no-re-cook; ready-job reconcile), 237 core tests green, typecheck +
  build clean. EYES-ON — cooked a song through the real dial-home worker protocol, restarted the
  process, confirmed the library lists it with its instrumental key + lyrics + pitch intact, that a
  re-request answers `alreadyReady` with no new job, that the hub accepts a re-queue, and
  screenshotted both new phone sections.
- [x] **B-5 · One search on the readiness axis + pull-up queue sheet** — *done, verified in a real
  browser.* Three pieces, in dependency order:
  1. **`sourceRef` is now immutable origin identity.** `markMediaReady` used to overwrite it with the
     stem key, so a cooked song could never be matched against its own search result again — every
     search for it minted a fresh UNCOOKED duplicate and the library version was unreachable
     (reproduced live: cooked `demo-takeonme` kept `stems/…wav` while a new ULID row appeared with
     `djV11Xbc914`). The stem key moved to `Media.instrumentalRef`, players ask the new pure
     `playbackRef(media)` helper for "what to load", and migration `0005` adds the column and
     backfills rows cooked under the old scheme. Same fix repairs a latent second bug: `sourceUri`
     would have handed a worker `youtube.com/watch?v=stems/…wav` for any job after the first.
  2. **One unified search.** The `?source=youtube|local` switch is gone from the UI: `/api/search`
     queries every resolver, materializes + persists each hit, and returns three groups — `ready`
     (stems on disk) / `cooking` (stems in flight) / `results` (plays with vocals) — deduped so a
     song appears EXACTLY ONCE. A dead source (yt-dlp missing, no network) no longer fails the whole
     search, and a known-cooked song is still offered when the resolver returns nothing. Phone gets
     readiness filter chips with live counts, one `SongRow` shape for all three states, and honest
     sub-lines: a raw row says *"sings with the original vocals"*, so the ✨ Karaoke button's value is
     self-evident. Cooking rows keep `＋ Turn` — rotation already holds a cooking song's slot
     (M7-C6), so cooking is not a blocked state. `/api/library` also returns what is cooking with
     live pct, so reloading mid-cook no longer loses the progress bar.
  3. **Pull-up queue sheet.** The rotation moved out of the main scroll into a bottom sheet, so
     browsing and queue-checking stop fighting over one scroll. The peek carries the question people
     actually ask — *"You're #2 · after Maya"* — which used to sit in a card that scrolled off the
     top. Pointer-drag to pull (verified with real mouse events: sheet top 588→317 up, back down on
     pull-down), and never drag-only — tap, Enter, ArrowUp/Down and Escape all work. Peek height is
     MEASURED and published to `:root` as `--peek-h`, because a hardcoded guess left the body
     bleeding out below the peek.
  **Three bugs found by driving the real UI, none of which unit tests could catch:** (a) the same
  song rendered in Ready *and* Popular *and* Recently-queued at once — the shortcut lists now
  subtract whatever the readiness groups already showed; (b) `WsClient` passed bare `setTimeout` as an
  option and called it as `this.#opt.setTimeoutFn(...)`, throwing `Illegal invocation` in a browser,
  so the WS **heartbeat never armed and capped-backoff auto-reconnect (M5-C6) never scheduled** —
  silently dead in production while tests passed on injected fake timers; (c) the peek-height bleed
  above. `SongCard` was deleted (superseded by `SongRow`); the `/components` gallery now shows all
  three readiness states.
  **Verified:** AUTO — 249 core + 35 shared tests green (+12 new: readiness partition incl. the
  appears-exactly-once invariant, client/server classification agreement, `playbackRef`,
  origin-survives-the-cook), typecheck + build clean. EYES-ON — searched a previously-cooked song and
  confirmed it returns once as ready with zero raw rows sharing its origin; drove join → all three
  groups → drag up → drag down → keyboard toggles, and screenshotted collapsed + expanded.
- [x] **B-6 · TV room-state clarity (lobby + persistent join QR)** — *done, verified by driving the
  real server through all three states.* The TV used to collapse every non-playing situation into ONE
  attract screen (`isAttract = tvState === 'attract' || !current`), so "nobody is here" and "four
  people are here waiting for a first pick" looked identical and the screen could not say what it was
  waiting for. Four pieces:
  1. **Presence on the wire (C1).** The WS upgrade now resolves *which singer* a socket belongs to
     from the session cookie (`readSessionToken` on the handshake request) — previously every socket
     was anonymous, so presence was impossible. A ref-counted `PresenceTracker` (multiple tabs per
     singer; a singer goes absent only on their LAST socket close, or a reconnect would flicker them
     out of the roster) drives a new `singer:presence{online}` broadcast on the 0→1 and 1→0
     transitions, and `queue:sync` carries an `online` snapshot so a client joining mid-party gets the
     roster immediately instead of on the next change. Presence is the roster source, NOT the singer
     table: that table is append-only and file-backed (H-5), so it accumulates everyone who ever
     joined and would show a night's worth of ghosts.
  2. **The three-way screen (C2).** Pure `tvScreen()` derives `attract | lobby | waiting | playing`
     with `playing` > `waiting` > `lobby` > `attract` precedence, so the M7-C6 cooking hold still wins
     over the lobby. `lobbyRoster()` caps chips (8) and reports the overflow so a 20-person party
     cannot push the strip over the screen, and skips a present id with no name yet rather than
     rendering a nameless "Someone" chip.
  3. **Lobby, layout option B (C2).** Chosen over the alternative: the QR keeps the stage, "Waiting
     for someone to pick a song…" sits under it, and the roster runs along the bottom as a strip with
     each singer's identity color. With a rehydrated queue and nobody reconnected the sub-line says
     "Scan to join" rather than the untrue "0 in the room".
  4. **Persistent corner join card (C3).** One `JoinBadge` serves both placements (`hero`/`corner`).
     The corner card is pinned **bottom-right on purpose and must stay there**: the "Now singing"
     lower-third owns bottom-left and the M8-C3 `ScoreBadge` owns top-right, so bottom-right is the
     only free corner — a top-right QR sits under the score mid-song. It carries the URL as text and
     a live "N singers in" line, so a latecomer glancing at the TV can join without stopping the music.
  **One crash the real-server drive caught that no unit test would have:** an `add` command whose
  `singerId` was missing sailed through `validateCommand` into the persistence write, where
  `queue_entries.singer_id` is `NOT NULL` — the `SQLiteError` threw out of `state.apply()` and **killed
  the whole server process**. Any client could end the party with one malformed message. Now rejected
  like any other bad op, with two regression tests.
  **Verified:** AUTO — 19 new tests (presence ref-counting + sync-snapshot, screen precedence incl.
  cooking-beats-lobby and rehydrated-queue, roster cap/overflow/nameless-skip, the singerId crash),
  268 core tests green, typecheck + build clean. EYES-ON — drove the live server: empty room → attract,
  two phones join → lobby names both, one closes → their chip goes within ~2s, queue a song → playing
  with the corner card and no collision. `docs/mocks/b6-tv-lobby-eyeson.png`,
  `docs/mocks/b6-tv-cornerqr-eyeson.png`.
- [ ] **B-2 · WebAudio pitch-shift (semitones offline)** — ±key currently no-ops on the TV (needs
  pre-rendered keyed variants, which aren't produced). Add a client-side phase-vocoder AudioWorklet
  on the TV so `keyShift` re-pitches the instrumental live (tempo preserved), and wire `keyShift`
  into `TvPlayer`. **Done-when:** ±1 semitone audibly shifts pitch without changing tempo.
  **Verify:** AUTO — pure cents→ratio + framing math unit tests; EYES-ON/AUDIO — the audible shift.
**Working order (set by the owner 2026-09-02):** **B-7** (media storage + library metadata) →
**B-3** (tiered lyrics source chain) → **B-4** → **M9-C1** → **M9-C3** → **B-2** last. B-7 goes first
because its metadata normalizer and provenance convention are what B-3 depends on; B-2 is last
because its only real acceptance test is audible and needs the owner in the room.

- [ ] **B-7 · Media storage layout + library metadata** — full spec:
  `docs/media-storage-spec.md`. Storage is currently accumulated convention, not design, and three
  things follow from that: (a) the raw downloaded original is retained **by accident** in
  `media/stems/_work/<mediaId>/source.wav`, a scratch path nothing ever cleans up — **432 MB of the
  volume's 1.2 GB across ~8 songs** — while being the one asset that cannot be regenerated if a video
  goes away; (b) nothing can be browsed, because `media.artist` holds the **YouTube uploader**
  (`7clouds`, `Musictainment TV 🇺🇸`) with the real artist buried in the title, and there is no album,
  year, genre or tag anywhere; (c) nothing is evictable (~150 MB/song, no cap) and the volume is not
  self-describing — losing the SQLite file loses every title and artifact link even though the bytes
  survive. Splits storage by **replaceability** into `state` / `audio` (unrecoverable) / `derived`
  (regenerable) / `meta`, each its own env-configurable path defaulting under `MEDIA_DIR` so existing
  installs need no changes, mounted as overridable compose volumes. Sidecar `meta/<id>.json` becomes
  authoritative with the DB as a rebuildable index, every derived field carries
  provenance + confidence (the same convention B-3 needs), and the untouched `raw` uploader/title is
  never discarded so a better normalizer can re-derive canonical fields without re-downloading.
  Browse comes from a `media_tags(media_id, kind, value)` table, not a column per taxonomy.
  **Done-when:** raw audio lives in `audio/` as a first-class asset with `work/` cleaned on job end;
  a `meta/`-only rescan rebuilds the library index from scratch; the phone can browse by artist and
  genre. **Verify:** AUTO — the pure normalizer against the live library's five rows as fixtures,
  migration idempotency, rescan round-trip, browse queries; EYES-ON — the browse UI.
- [ ] **B-3 · Tiered lyrics source chain** (rewritten 2026-09-02; was "offline lyrics / WhisperX
  transcribe fallback") — the original framing assumed LRCLIB reachability was the blocker. It is not
  the only one, and it is not the first one. Four gaps, in dependency order:
  1. **Nothing enqueues an align job.** `make-karaoke.ts:93` is the *only* `enqueue` call in the
     server and it is hardcoded `'stems'`, while `JobType` is `'stems' | 'align' | 'score'`. So
     lyrics (M8-C2) and live scoring (M8-C3) are both unreachable **regardless of LRCLIB** — two
     milestones marked shipped that cannot fire. The align/pitch processors exist and are tested;
     they are simply never asked to run.
  2. **`job:assign` cannot carry what align needs.** The contract is `params: { model?, targetKey? }`
     and worker-hub sends only `{ model }`, but `WhisperXProcessor` hard-raises without
     `params.artist` + `params.track` and also wants `language` + `durationSec`.
  3. **Metadata, not the lyrics DB, is the real coverage blocker.** An LRCLIB lookup would ask for
     *"7clouds — Britney Spears - Baby One More Time (Lyrics)"* and get nothing: **4 of 5 songs in the
     live library miss on metadata alone even with LRCLIB perfectly reachable.** Fixed by B-7's
     normalizer, which is why B-7 goes first.
  4. **The live worker advertises only `stems`** (`ENCORE_WORKER_CAPABILITIES=stems`), so a correct
     align job would sit queued forever.
  **The design shift (revised 2026-09-02 with the owner): TEXT QUALITY and TIMING FIDELITY are
  INDEPENDENT AXES, and ASR runs on every song regardless.** The earlier framing collapsed them into
  one ordered chain that returns a single winner, which throws away most of the value:

  | Source | Text | Timing it yields unaided |
  |---|---|---|
  | LRCLIB `syncedLyrics` (LRC) | authoritative | **line-level** — no ML, no audio at all |
  | LRCLIB plain / YouTube captions | good | none — needs forced alignment |
  | ASR on the vocals stem | **dubious** | **word-level** |

  The ideal artifact is *authoritative text force-aligned to the audio* — it needs BOTH halves, so
  they cannot be alternatives to each other. Two consequences the linear design missed:
  - **Line-level sync is the FLOOR, word-level is the ideal** (owner's bar: never play with no sync
    at all). Raw LRC clears the floor with zero ML and zero audio, so lyrics can be ready *before*
    the instrumental — which removes the "first play has no lyrics" cost that chaining would incur.
  - **ASR is the inverse of the intuition:** worst tier for words, but word-level timing for free.
    So the honest-presentation requirement matters *most* exactly where the timing looks best.

  **Why ASR always, not just as a fallback.** Beyond guaranteeing a floor, it is a VALIDATION
  signal: LRCLIB's real failure mode is a confident WRONG match (fuzzy metadata returns another
  song's lyrics, and nothing today would catch it). Comparing ASR of what is actually sung against
  the authoritative text scores agreement — rough agreement raises confidence, wild divergence means
  the lookup fetched the wrong song. It also supplies the `language` that `align()` needs and which
  is currently a hardcoded `'en'` guess, plus vocal-presence detection (a true instrumental).

  **Therefore: MULTIPLE lyrics+alignment sets per song, not one.** `artifacts.lyrics` becomes a set
  of candidates — `{ ref, textSource: lrclib|captions|asr|manual, timing: word|line|none,
  textConfidence, timingConfidence, language, createdAt }` — plus a `chosen` pointer the TV loads.
  This buys an **upgrade path with no recompute**: ASR lands first; when LRCLIB becomes reachable (or
  text is pasted in) re-align *from the retained audio* — no re-download, no re-separation. And it
  can never regress: a new line-level source cannot overwrite existing word-level timings.
  Presentation is then a pure `pickBestLyrics(candidates)`, ranked:
  1. authoritative text + word timings, 2. **authoritative text + line timings**, 3. ASR text + word
  timings (labeled auto-transcribed), 4. nothing — an honest "no lyrics" state, never a blank overlay.
  **2 ranks above 3 deliberately:** wrong words are a failure (you cannot sing them), whereas correct
  words with coarse highlighting is the accepted minimum.

  **Environment facts.** `huggingface.co` returns HTTP 200, so WhisperX models download and the ASR
  tier is verifiable end-to-end here with real ML — this **falsifies the old note** that real-ML
  lyrics verification had to be flagged for a human. On `lrclib.net` the record was WRONG: an earlier
  note claimed a corp DNS sinkhole + `CERTIFICATE_VERIFY_FAILED` as a property of the environment. Re-measured
  2026-09-02 from the repo shell: `lrclib.net` fails DNS outright (`gaierror`) while `huggingface.co`
  and `www.youtube.com` resolve fine from the *same* shell — so it is a block on **this laptop**, not
  a fact about the project. `LrclibClient` already takes `base_url` (`lyrics_source.py:180`); wiring
  it to `ENCORE_LRCLIB_BASE` allows a proxy or a **self-hosted LRCLIB from their published DB dump**,
  which suits a party box better than a live API call over party wifi. Tests already inject a fake
  fetcher, so C1–C3 are fully buildable here; only the live lookup waits on network. Captions were
  probed on two library videos: one had none, the other only auto-generated — a middle tier, not an
  authoritative one. Musixmatch has the best catalog but its terms generally forbid storing lyrics,
  at odds with a self-hosted cache; Genius-class sites give good text but only via scraping.

  **Done-when:** a cooked song shows word-timed lyrics on the TV with LRCLIB unreachable; a song with
  authoritative text but no alignment still scroll-syncs by line; and the overlay distinguishes
  authoritative text from auto-transcribed. **Sub-commits:**
  - [ ] **B-3-C1 · enqueue `align` + carry its params + `ENCORE_LRCLIB_BASE`.** Widen `job:assign`
        params past `{ model?, targetKey? }`; derive `artist` from `artistCanonical ?? artist`, plus
        `track`/`language`/`durationSec`; enqueue align alongside stems. *Done-when:* a cook produces
        a queued align job a capable worker ACCEPTS instead of rejecting. **AUTO** — params derivation
        incl. the null-`artistCanonical` case, enqueue dedup. Shared-contract change: stage
        `packages/shared` in the SAME commit (Gotcha #10).
  - [ ] **B-3-C2 · candidate model + `pickBestLyrics` (pure).** Candidate shape, the ranking above,
        the never-regress rule, and ASR↔authoritative agreement scoring. **AUTO** — no network, no ML.
  - [ ] **B-3-C3 · split acquisition from timing in `whisperx.py`.** The producer emits *candidates*
        instead of one doc; the injectable `Aligner` seam (already clean, already degrades to
        line-sync) is untouched. **AUTO** with fake sources.
  - [ ] **B-3-C4 · ASR tier (real ML).** A `Transcriber` seam mirroring `Aligner`, run on the VOCALS
        stem (a full mix transcribes badly). **REAL-ML**, runnable here. Measure the added cook cost —
        ASR on every song is a second pass alongside Demucs on the same cores.
  - [ ] **B-3-C5 · multi-candidate storage + `chosen` threading.** Sidecar `artifacts.lyrics` set
        (a `schema` bump, with a read path for old single-ref records), `setMediaLyrics` → set
        semantics, `Media` carries the chosen ref + provenance. **AUTO**
  - [ ] **B-3-C6 · TV honesty + the line-sync floor.** Overlay distinguishes authoritative from
        auto-transcribed and renders line-level as a stanza scroll. **AUTO** + **EYES-ON** via `/components`.
  - [ ] **B-3-C7 · captions tier + re-align-on-better-text** (the upgrade path C5 makes possible).
  **Deferred by the owner:** the human paste-in tier (needs a core endpoint + phone UI + storage).
  **Prerequisite, not a commit:** `whisperx==3.8.6` in the worker venv and
  `ENCORE_WORKER_CAPABILITIES=stems,score,align` — C4 cannot be verified without it.
- [ ] **B-4 · Hot-titles persistence** — the popularity tracker is in-memory (survives refresh, not
  restart). Persist counts to the DB so "🔥 Popular tonight" survives a restart. **Verify:** AUTO — unit.
- [ ] **M9-C1 · accounts** (claim an ephemeral singer; join flow never regresses) — later.
- [ ] **M9-C3 · multi-room** (room codes, per-room topics; two rooms on one core) → tag **v1.0.0** — later.

---

## Deferred — future (not in the auto-cook queue)

Deliberately parked. The loop must NOT pick these up; they come back only if the owner says so.

- **M8-C4 · end-of-song score reveal + session leaderboard** — deferred 2026-09-02 to close M8.
  Live scoring already works on both surfaces (M8-C3), so this is presentation polish on top of a
  capability that exists, not a gap. If revived: pure leaderboard aggregation from `score:update`
  (AUTO-testable) + an end-of-song reveal on the TV and phone, and it carries the **v0.3.0
  (scoring)** tag with it.

---

## Critical path (the spine, in order)
`M0-C1 (adapter gate)` → `M0-C2/C4` → **M1 (realtime spine)** → `M3-C2/C3 (live optimistic queue)`
→ `M4-C1/C4 (search)` → **M5-C1/C3 (gapless playback)** → `M6-C3/C4 (e2e + one-container ship)` =
**MVP / v0.1.0**. Everything in M7+ hangs off the `playMode` flag and job ledger without a rewrite.

## Parallelizable (off the critical path)
- M0-C5/C6 (tokens, PWA) alongside M1.
- M2 (join) alongside late M1.
- M3-C7 (motion polish), M6-C1 (thumbs) anytime after their surface exists.
- All of M7's Python worker (M7-C4/C5/C8) can be built in parallel with core once the protocol
  (M7-C3) is fixed.

## Counts
M0:7 · M1:7 · M2:4 · M3:7 · M4:5 · M5:6 · M6:6  → **MVP = ~42 commits**
M7:11 · M8:4 · M9:3  → **full vision = ~60 commits**
