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
- [~] **M7-C5** ★ Demucs `htdemucs` stems pipeline → instrumental written to MediaStore.
  `demucs.py`: PURE helpers (yt-dlp/demucs argv builders, `--two-stems=vocals` → `no_vocals.wav`
  path resolver, yt-dlp + tqdm progress parsers, permanent-vs-transient `classify_retryable` +
  structured `ProcessError`) split from the I/O `DemucsProcessor` (download→separate→publish via an
  INJECTABLE async runner; emits downloading→separating progress; local sources skip download).
  Wired into `dial_home.py` as the env-selectable default (`ENCORE_PROCESSOR=demucs|stub`); the
  failure path now honors `ProcessError.retryable`. **Verified (no-ML):** 14 pytest drive the full
  download→separate→publish flow with a fake runner (canned CLI output, files faked) — youtube +
  local-source paths, progress ramping, missing-output guard, retryable vs non-retryable failures;
  worker suite 14→28, core 167 / shared 25 green. **DEFERRED to a GPU/worker box:** the real-ML
  done-when ("a real song yields an instrumental on the volume") — needs the worker image (multi-GB
  torch) + actual demucs/yt-dlp, which this aarch64 sandbox can't build/run. Code + tests are ready;
  flip `[~]`→`[x]` after a real `docker compose --profile stems` run produces a real instrumental.
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
- [~] **M7-C8** WhisperX align → word-timed lyrics artifact. `whisperx.py`: PURE
  `normalize_lyrics` (raw WhisperX segments → `{language, lines:[{start,end,text,words:[{word,
  start,end}]}], words:[flat]}` — drops un-timed/blank words, derives line bounds from words,
  rejects NaN/inf, skips untimed garbage lines), `is_valid_lyrics`, argv/path helpers — split from
  the I/O `WhisperXProcessor` (download→align→normalize→write via the shared injectable runner).
  `RoutingProcessor` dispatches by job type (stems→Demucs, align→WhisperX, score→Demucs); worker
  builds it from its advertised CAPABILITIES (lazy imports keep torch off unless needed). requirements
  pins whisperx==3.1.1. **Verified (no-ML):** 13 pytest — the done-when shape transform (lines +
  flat words, every word word/start/end, line-bound derivation, NaN/inf + garbage rejection,
  validity) + the download→align→write flow with a fake runner (artifact written + re-parsed),
  local-source skip, missing-transcript + instrumental-no-words guards, routing dispatch. Worker
  28→41 pass, core 177 / shared 25 green. **DEFERRED to a GPU box:** the real WhisperX alignment
  (multi-GB torch) — same constraint as C5; flip `[~]`→`[x]` after a real align on a worker box.
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
  worker 41→47 pass; svelte-check 0/0; build green. **DEFERRED to a worker box:** the actual ffmpeg
  pitch RENDER of the variants — this sandbox's ffmpeg is a stripped 16-filter build (no atempo/
  asetrate/rubberband); the worker image apt-installs full ffmpeg.
- [ ] **M7-C10** MediaStore `object` impl (MinIO/S3) for remote workers + env flip. **Done-when:**
  worker on a second box processes via object-store; integration test.
- [ ] **M7-C11** tag **v0.2.0 (stems)**.

---

## M8 — Scoring  → *ships: SingStar-style scoring*

- [ ] **M8-C1** pitch extraction from the isolated vocal stem (per-frame f0). **Done-when:** unit
  test: known tone → expected pitch track.
- [ ] **M8-C2** aligned lyrics overlay on TV (bouncing-ball from WhisperX timings). **Done-when:**
  eyes-on: words highlight in time.
- [ ] **M8-C3** live mic pitch compare → `score:update` WS event (computed server-side).
  **Done-when:** eyes-on: score moves with sung pitch; TV overlay + phone reflect it.
- [ ] **M8-C4** end-of-song score reveal + session leaderboard. **Done-when:** eyes-on reveal;
  leaderboard persists for the session. Tag **v0.3.0 (scoring)**.

---

## M9 — Accounts (additive, never gates the party)  → *ships: persistence across nights*

- [ ] **M9-C1** real accounts layered over ephemeral singers (OAuth or local). **Done-when:**
  ephemeral singer can "claim" an account; nothing about join flow regresses.
- [ ] **M9-C2** history + favorites + saved-karaoke library. **Done-when:** re-queue a saved
  karaoke instantly (skips the worker). 
- [ ] **M9-C3** multi-room (the deferred scale knob): room codes, per-room topics. **Done-when:**
  two independent rooms run on one core. Tag **v1.0.0**.

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
