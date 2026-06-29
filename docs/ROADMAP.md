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
- [ ] **M3-C7** 60fps motion pass: transform/opacity-only animations, spring reorder, finger-
  tracking bottom sheet. **Done-when:** no layout-thrash in devtools; eyes-on smoothness.

---

## M4 — Search & media resolve  → *ships: find a song, queue it*

- [ ] **M4-C1** ★ media resolver iface (`src/server/media`) + `local` library scan + SQLite FTS.
  **Done-when:** unit test: FTS returns ranked local matches.
- [ ] **M4-C2** ★ YouTube search proxy + result cache + dedupe by query. **Done-when:** unit test:
  second identical query served from cache (no upstream call).
- [ ] **M4-C3** yt-dlp metadata resolver (title/artist/duration/thumb) + per-video-id cache.
  **Done-when:** unit test: resolve memoizes; cache hit on repeat id.
- [ ] **M4-C4** ★ search UI: unified bar, YouTube/Library tabs, debounce ~150ms, **cancel
  in-flight** on keystroke. **Done-when:** eyes-on: typing cancels stale requests; results stream.
- [ ] **M4-C5** zero-keystroke shortcuts: "recently queued" + "popular tonight". **Done-when:**
  eyes-on populated from session history.

---

## M5 — Playback & gapless TV  → *ships: songs actually play, with zero dead air* ★★

- [ ] **M5-C1** ★ player state machine (`src/server/playback`): authoritative; advances on
  `tv:telemetry {ended}`, emits `nowplaying:changed{current,upNext}`. **Done-when:** unit test:
  ended telemetry advances rotation, picks next by seq.
- [ ] **M5-C2** ★ TV player abstraction over `playMode`: `iframe` (YouTube IFrame API) + `file`
  (`<video>`). **Done-when:** eyes-on: a YouTube song and a local file both play on `/tv`.
- [ ] **M5-C3** ★★ two-player gapless preload (`src/lib/tv`): A visible / B hidden-warming,
  preload `upNext` at ~25%, swap on `ended`. **Done-when:** eyes-on: back-to-back songs with **no
  black gap**; `bufferedNextPct` reported in telemetry.
- [ ] **M5-C4** interstitial + `Now singing` lower-third (configurable 0–4s). **Done-when:**
  eyes-on: "Next up: NAME — SONG" reveal, then hard-cut/crossfade.
- [ ] **M5-C5** ATTRACT/LOADING/WAITING states wired to the machine (held-slot stub: skip if
  next not ready). **Done-when:** eyes-on: empty queue → attract; song flows return.
- [ ] **M5-C6** TV reconnect resilience: socket drop mid-song doesn't stop playback; resyncs.
  **Done-when:** kill socket during PLAYING → video continues → state resyncs on reconnect.

---

## M6 — MVP hardening & ship  → *ships: `docker compose up`, a real party* ★

- [ ] **M6-C1** thumbnail proxy + on-disk cache + long cache headers. **Done-when:** repeat thumb
  served from disk; eyes-on grid.
- [ ] **M6-C2** WS resilience hardening: backoff caps, dedupe by `clientOpId`, ack-timeout resend.
  **Done-when:** flaky-network sim (drop 20%) keeps two phones converged.
- [ ] **M6-C3** ★ Playwright e2e: join → search → queue → rotate → play → gapless next, two
  phones + TV. **Done-when:** e2e green headless.
- [ ] **M6-C4** ★ `apps/core/Dockerfile` (`FROM oven/bun`, bundle yt-dlp + ffmpeg) + `compose up`
  one-container boot. **Done-when:** clean `docker compose up` → working app on a fresh checkout.
- [ ] **M6-C5** error/empty/edge states (no results, dead video, singer leaves mid-turn) +
  graceful toasts. **Done-when:** eyes-on each edge; no dead-ends.
- [ ] **M6-C6** README quickstart + screenshots; tag **v0.1.0 (MVP)**. **Done-when:** a stranger
  can stand it up from README alone.

---

## M7 — Smart feature: make-karaoke (container 2)  → *ships: drop a song → stems* ★

- [ ] **M7-C1** ★ job ledger (`src/server/jobs`): Drizzle `jobs` table, dedup `(mediaId,jobType)`,
  state machine queued→assigned→running→ready/failed/canceled. **Done-when:** unit test: full
  lifecycle + dedup + idempotent re-add.
- [ ] **M7-C2** ★ leases + reaper (ack 10s / progress 30s), boot resets assigned/running→queued.
  **Done-when:** unit test: stalled job requeues; boot recovery clears in-flight.
- [ ] **M7-C3** ★ dial-home worker protocol on core: `worker:hello/heartbeat`, dispatch by
  priority(=rotationSeq), `job:assign/accept/progress/complete/failed`. **Done-when:** unit test
  with a fake worker socket drives a job to `ready`.
- [ ] **M7-C4** ★ worker container: Python `dial_home` full + `Bun.spawn`-free pull/push via
  MediaStore; `apps/worker/Dockerfile` (torch+ffmpeg). **Done-when:** `--profile stems` worker
  registers with core.
- [ ] **M7-C5** ★ Demucs `htdemucs` stems pipeline → instrumental written to MediaStore.
  **Done-when:** a real song yields an instrumental track on the volume.
- [ ] **M7-C6** ★ `playMode` flip iframe→file on `ready`; rotation **held-slot** real impl
  (keep seq, slot back when ready). **Done-when:** queue a make-karaoke song; it cooks, then
  plays gaplessly at its fair position.
- [ ] **M7-C7** ★ live progress UI: `media:status` → `ProcessingCard` bar (`Separating… 68%`) +
  stage chips. **Done-when:** eyes-on: phone shows live stages end-to-end.
- [ ] **M7-C8** WhisperX align → word-timed lyrics artifact. **Done-when:** lyrics JSON with word
  timestamps stored; unit test on shape.
- [ ] **M7-C9** `+key/−key` pitch shift (ffmpeg/rubberband on the instrumental). **Done-when:**
  eyes-on: control strip shifts key on a `file` song.
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
