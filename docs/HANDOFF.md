# Encore — Agent Handoff

> **Purpose.** The single onboarding doc for an agent (or human) picking up Encore cold. What's
> built, how to run and test it without tripping the traps, what's unpushed, and where to start next.
>
> **Last updated:** 2026-09-02 · **State:** `v0.2.0` (stems) shipped; M0–M8 closed; on the backlog.
> **Read this first, then:** `docs/MASTER-DESIGN.md` → `docs/ROADMAP.md` → the two contracts
> (`reconciliation-contract.md`, `job-lifecycle-and-worker-protocol.md`).

---

## 0. TL;DR for the next agent

- **Everything through M8 is done**, plus backlog **B-1, B-5, B-6, B-7**. MVP (`v0.1.0`),
  make-karaoke/stems (`v0.2.0`), scoring (M8-C0–C3), media storage classes + browse + retention (B-7).
- **401 tests pass from the repo root** (366 core + 35 shared), **96 worker tests** pass under
  pytest. `bun run typecheck`, `bun run check`, `bun run build`: 0 errors. Gotchas #1 and #9 are
  **fixed** — no more cwd dance.
- **Real Demucs verified on this box** (macOS/arm64, CPU, no Docker): a 4:01 song → a 6.0 MB
  AAC 44.1k stereo instrumental in ~2 min, served 200. Needed `soundfile` — see Gotcha #13.
- **`main` is in sync with `origin/main`** (`05d5fb0`); tags `v0.1.0`/`v0.2.0` are pushed. See §5 —
  agents still cannot `git push`.
- **Next work is the backlog, not a milestone.** Start at **B-2** (WebAudio pitch-shift) — see §7.
- **A worker is a separate process.** Core alone leaves every make-karaoke request at `queued`
  forever; there is no warning in the UI. See §3 for running it with or without Docker.
- **The single most important lesson from the last three sessions:** every real defect found lately
  was invisible to a green test suite and only surfaced by driving the actual app. Budget for that
  (§8). Do not report a feature working on unit tests alone.

---

## 1. What Encore is

Self-hosted, mobile-first karaoke webserver (personal project, `github.com/OnlyOneByte/Encore`).
Scan a QR on your phone → pick a name+color (no signup) → search → one-tap queue. A TV/stage surface
plays videos **gaplessly** with round-robin rotation (everyone's 1st pick before anyone's 2nd).
**Make-karaoke** strips vocals on demand via Demucs; word-timed lyrics and live pitch scoring ride on
top of the stems.

Design pillars: **UI-first, wicked-fast/optimistic, as close to one container as possible.**

---

## 2. Tech stack (locked — don't re-litigate)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Bun 1.3.14** (aarch64/AL2) | native WS pub/sub, `bun:sqlite`, `Bun.spawn` |
| Web | **SvelteKit + Svelte 5 runes** + PWA | `svelte-adapter-bun` → `getHandler()` |
| Bundler | **Vite 8** | `bun --bun` is **required** |
| DB | **Drizzle + `bun:sqlite`** (WAL) | migrations in `apps/core/drizzle/`, applied at boot |
| Monorepo | **Bun workspaces** | `packages/shared` = the contract; `apps/core`; `apps/worker` |
| Worker | **Python + Demucs + WhisperX** | container 2, dial-home WS client. **Real and working.** |

**The case for Bun was made and accepted.** Do not propose Node/Deno swaps.

### Repo layout
```
Encore/
├─ docker-compose.yml     # core (always) + worker (profile: stems)
├─ push.sh                # the ONLY way an agent can push (see §5)
├─ docs/                  # MASTER-DESIGN, ROADMAP, contracts, this file, mocks/
├─ packages/shared/       # @encore/shared — types, ops, rotation reducer, events, ulid, colors
└─ apps/
    ├─ core/              # @encore/core — the SvelteKit app + server
    │   ├─ server.ts        Bun.serve entry: HTTP + WS hub + presence + worker transport
    │   ├─ drizzle/         migrations 0000–0005
    │   ├─ src/server/      app.ts (singleton), db/, realtime/, state/, media/, jobs/, rotation/, singers/
    │   ├─ src/lib/         stores/, ws/, tv/ (gapless, lobby, lyrics, score), components/, readiness.ts
    │   └─ src/routes/      +page (phone), tv/, join/, components/ (dev gallery), api/
    └─ worker/             # dial_home.py + Demucs/WhisperX processors + pytest
```

---

## 3. How to run & test (read §4 first)

```bash
# --- tests + gates (all runnable from the REPO ROOT now, see Gotcha #1) ---
bun test                            # → 401 pass / 0 fail (366 core + 35 shared)
bun run typecheck                   # both workspaces → 0 errors
bun run check                       # svelte-check → 0 errors
cd apps/worker && pytest            # → 96 pass (needs `pip install pytest pytest-asyncio`;
                                    #    pytest.ini sets asyncio_mode=auto, so without
                                    #    pytest-asyncio 27 "fail" spuriously)

# --- dev / prod (root scripts proxy to @encore/core) ---
bun run build && bun run start      # prod build + serve; `start` → server.ts
bun run dev                         # vite HMR for UI ONLY — the WS hub lives in server.ts

# --- container ---
docker compose up                   # core only
docker compose --profile stems up   # + the Python worker
```

`data/` and `media/` are created on first boot (`openDb` mkdirs `DATA_DIR`), so a fresh clone needs
no manual setup. `ENCORE_EPHEMERAL=1` swaps in an in-memory DB for a throwaway run.

**Running the worker WITHOUT Docker** (verified on macOS/arm64, Python 3.10, CPU-only):
```bash
cd apps/worker && python3 -m venv .venv
.venv/bin/pip install torch==2.8.0 torchaudio==2.8.0 demucs==4.0.1 yt-dlp   # ~2 min, multi-GB
PATH="$PWD/.venv/bin:$PATH" ENCORE_CORE_WS='ws://localhost:3000/ws?role=worker' \
  ENCORE_WORKER_CAPABILITIES='stems,score' MEDIA_DIR=../core/media \
  .venv/bin/python -m src.dial_home
```
The worker shells out to `yt-dlp`/`ffmpeg`/`demucs` **by name via PATH**, so the `PATH` prefix is
load-bearing. Launching **core** with that same venv `bin` on PATH also gives core its `yt-dlp`, so
YouTube search starts returning results. `MEDIA_DIR` must be the SAME dir core uses.
`ENCORE_PROCESSOR=stub` (needs only `pip install websockets`) exercises the full
assign→progress→complete→ready path with **placeholder files that will not play** — plumbing only.

**Serving for eyes-on verification (the established local loop):**
```bash
cd apps/core && bun run build
PATH="/home/angryang/.local/share/mise/installs/python/3.12.13/bin:$PATH" \
  HOST=127.0.0.1 PORT=5180 bun run server.ts
```
Port **5180** by convention (3000 is usually taken by another project on this box). yt-dlp lives on
that mise python path and `ytdlp.ts` calls it **by name via PATH**, so the server must be launched
with that dir on PATH or YouTube search silently returns nothing. Always bind **127.0.0.1**.

**Sharing it with the owner:** `tunnel create 5180 --name encore` →
`https://angryang-encore.v.tunnels.lab.aws.dev` (Midway SSO, owner-only). WebSockets forward fine.
Tunnel the **built** server, never `vite dev` — the realtime layer is in `server.ts`. The tunnel
agent dies on its own sometimes; the server survives it, so just restart the tunnel.

---

## 4. Gotchas (each one costs an hour)

1. ~~**Run `bun test` from `apps/core/`, not the repo root.**~~ **FIXED.** `runMigrations()` now
   locates `apps/core/drizzle` by walking up from `import.meta.dir` (`db/migrate.ts`), so
   `bun test` works from **anywhere** — 401 pass from the repo root. `ENCORE_MIGRATIONS_DIR`
   overrides if the folder ever moves.
2. **`.npmrc` is repo-local and pins PUBLIC npm on purpose.** Corp box: the *global* npmrc points at
   CodeArtifact and 401s for public packages. Don't delete it, don't `npm config set` globally.
3. **`bun --bun` is mandatory** for SvelteKit/Vite. Use `bun run <script>`; never call `vite` raw.
4. **`globalThis`-backed singleton.** `getApp()`/`setPublish()` in `src/server/app.ts` behind a
   `globalThis` symbol, reached via the `$server` alias. **Deliberate** — the SvelteKit handler is a
   *separate bundle* from `server.ts`, so a module-level singleton split-brains (two in-memory
   queues, two DBs). Route any new server singleton through `app.ts`.
5. **`.gitignore` runtime dirs are ANCHORED (`/data/`, `/media/`).** An un-anchored `media/` once
   matched `src/server/media/` and silently excluded the whole search subsystem from git.
6. **Don't kill processes by broad pattern.** `pkill -f 'bun ...'` can self-match the harness. Use
   `lsof -ti tcp:5180 | xargs -r kill`.
7. **`git push` is blocked for agents** (§5). `rm -rf`/`DROP TABLE` too. The guards catch script
   evasion — surface the blocker, don't route around it.
8. **`bun:sqlite` UNRESOLVED_IMPORT during `bun run build` is harmless.** Bun resolves built-ins at
   runtime. Not a real warning to chase.
9. ~~**`bun run typecheck` from the repo ROOT exits 127.**~~ **FIXED.** It was code, not
   environment: `@encore/shared` declared a `tsc --noEmit` script but had neither `typescript` nor a
   `tsconfig.json`. Both added, so root `bun run typecheck` now checks **both** workspaces clean.
   Turning it on surfaced 3 latent `noUncheckedIndexedAccess` errors in `rotation.ts` (fixed) — that
   package's own sources had never actually been typechecked.
10. **Stage files explicitly; never `git add .`** — `.kiro/` is local tooling and must stay
    untracked. And **check `git status` after committing**: a B-6 commit shipped without its
    `packages/shared` contract change and was not buildable in isolation, because the local
    verification ran on a working tree the commit didn't describe.
11. **Node 20 for `playwright-cli`/playwright** — `export PATH="$HOME/.local/share/mise/installs/node/20.20.2/bin:$PATH"`.
12. **Cap eyes-on screenshots at ≤2000px** (1280×720 viewport, `deviceScaleFactor: 1`). An oversized
    image hard-fails the agent turn and keeps re-firing from history.
13. **`soundfile` is REQUIRED for stems, and its absence looks like a hang.** torchaudio 2.8 has no
    audio-write backend, so demucs separates to **100%** and *then* dies with `Couldn't find
    appropriate backend to handle uri .../vocals.wav`. It reaches you as a song frozen at
    "separating 100%" that silently retries 3× (a full separation pass each). It's now pinned in
    `requirements.txt`; before that it only arrived transitively via `whisperx`, so a stems-only
    worker was broken while the full install worked.
14. **A `failed` job leaves the media stuck showing `queued`/cooking forever.** Nothing surfaces the
    error to the phone or TV, and terminal jobs are never retried, so the song just sits there. To
    recover: delete the failed row from `jobs` and reset that media's `stem_status` to `none`
    (dedup is on `(mediaId, jobType)`, so a re-tap alone won't re-enqueue). Worth a real fix.
15. **Read the `jobs` table when a cook misbehaves** — its `error` column has the actual message,
    which is often the ONLY place it exists. The worker now also prints failures (it used to report
    them over the wire only, making retry loops invisible from both ends). Note the column is
    `error`, not `last_error`.
16. **Not every YouTube video downloads.** yt-dlp hits `This video is not available` + an
    n-challenge-solving warning on some ids; the job fails at stage `downloading` after 3 attempts.
    That's upstream/bot-checking, not an Encore bug — try another video before debugging.

---

## 5. Git state & the push blocker ⚠️

- Branch `main` is **in sync** with `origin/main` at `05d5fb0` (B-7-C5, retention).
- **Tags `v0.1.0` and `v0.2.0` are pushed.** The earlier backlog (B-1/B-5/B-6 + fixups) all landed
  upstream; the squash note that used to live here is moot.

**Agents cannot run `git push`** — the harness blocks it in any shell command (the failure
misleadingly reads "User denied tool execution"; it is *not* a user cancellation). The only allowed
path is:

```bash
MESHCLAW_ALLOW_GIT_PUSH=1 bash push.sh    # from the repo root; env -u GIT_SSH_COMMAND inside
```
A human should also push the tags: `git push origin v0.1.0 v0.2.0`.

Commits use the personal **`OnlyOneByte`** identity. Convention: **one commit per roadmap
sub-task/backlog item**, message prefixed with its id (`B-6:`, `M7-C1:`), tests land with the commit.

---

## 6. Architecture & invariants you must not break

### The reconciliation contract (the heart of "wicked fast")
Full spec: `docs/reconciliation-contract.md`. The invariant:

> **`client.predict(op) === server.apply(op)` for EVERY mutation path**, including round-robin resequencing.

Client-minted ULID per op; server holds a monotonic `rev`; client keeps a pending-op Map and applies
the inverse on reject; server broadcasts `queue:patch{rev, ops, causedBy, entries, media}` with the
authoritative snapshot **inline**; rev-gap detection triggers resync. The shared reducer
`packages/shared/src/rotation.ts` (`applyAndReseq`) is used by **both** sides — keep them on the same
function or the invariant breaks.

**Validate every field a client sends.** An `add` with a missing `singerId` once reached the
`NOT NULL singer_id` write and threw out of `state.apply()`, **killing the whole server process** —
one malformed message could end a party. Validation lives in `hub.ts:validateCommand`.

### Rotation
`rotate` / `assignSeqs` / `applyAndReseq`. Terminal entries (`done`/`canceled`) are pruned on apply
and hydrate. The **held-slot rule** (a singer keeps their seq while their make-karaoke song cooks) is
real as of M7-C6: a not-yet-ready `file` entry is skipped by `isEntryReady` but keeps its seq.

### Media identity (learned the hard way in B-5)
`sourceRef` is **immutable origin identity**; the cooked stem key lives in `Media.instrumentalRef`
and players ask `playbackRef(media)` what to load. Overwriting `sourceRef` on cook made a song
unmatchable against its own search result forever (every search minted a fresh uncooked duplicate).

### Presence (B-6)
The WS upgrade resolves **which singer** a socket belongs to from the session cookie; a ref-counted
`PresenceTracker` broadcasts `singer:presence{online}` on 0→1 and 1→0 only, and `queue:sync` carries
an `online` snapshot for mid-party joiners. **Never use the `singers` table as "who's here"** — it is
append-only and file-backed, so it accumulates everyone who ever joined.

### TV surfaces (B-6)
Four states via the pure `tvScreen()` in `src/lib/tv/screen.ts`, precedence
`playing > waiting > lobby > attract`:
- **attract** — nobody here: full-screen join QR.
- **lobby** — people here, nothing queued: hero QR + "Waiting for someone to pick a song…" + a
  presence-derived roster strip.
- **waiting** — queued but stems still cooking.
- **playing** — video + lower-third + a compact join card.

**The join card is bottom-right and must stay there:** the lower-third owns bottom-left and the
M8-C3 `ScoreBadge` owns top-right.

### Gapless TV
Two-player swap (A visible / B warming, swap on `ended`), telemetry-driven `advance()`.
`src/lib/tv/gapless.ts` + `TvPlayer.svelte`; server side `realtime/player.ts`. Spec:
`docs/tv-preload-state-machine.md`.

### Jobs & the worker
Ledger with dedup on `(mediaId, jobType)`, leases + reaper (ack 10s / progress 30s), boot recovery
resets orphaned `assigned`/`running` → `queued`. Workers **dial home** over WS and advertise
capabilities. Note: `make-karaoke` enqueues only a **`stems`** job — live scoring needs a separate
**`score`** job *and* a worker advertising that capability.

### Security posture (keep intact)
SSRF host-allowlist + https-only on the thumb proxy; path-traversal guard on `/media`
(`safeMediaPath`); `uniqueIndex` on the session token; yt-dlp query passed as a single argv element
with a kill-timer. `docker-compose.yml` has `no-new-privileges` + `cap_drop: [ALL]`, non-root user,
pinned base image and yt-dlp version.

---

## 7. Where to start next: the backlog

M9 is the only open milestone, but the prioritized queue in `docs/ROADMAP.md` ("Backlog — auto-cook
queue") is the real order of work. Done: **B-1** (saved-karaoke library), **B-5** (unified readiness
search + pull-up queue sheet), **B-6** (TV room states + presence). Remaining:

- **B-2 ★ START HERE — WebAudio pitch-shift.** ±key currently no-ops on the TV. Add a client-side
  phase-vocoder AudioWorklet so `keyShift` re-pitches the instrumental live, tempo preserved.
  *Done-when:* ±1 semitone audibly shifts pitch without changing tempo. AUTO for the cents→ratio and
  framing math; **EYES-ON/AUDIO** for the shift itself.
- **B-3 · Offline lyrics (WhisperX transcribe fallback).** LRCLIB is DNS-sinkholed on this box, so
  lyrics genuinely **cannot** display here today: transcribe the vocals stem directly instead of
  aligning known text. Needs the worker to advertise `align` and an align job enqueued alongside stems.
- **B-4 · Hot-titles persistence.** The popularity tracker is in-memory; persist counts so
  "🔥 Popular tonight" survives a restart. AUTO.
- **M9-C1 · accounts** (claim an ephemeral singer; join flow must not regress) — later.
- **M9-C3 · multi-room** (room codes, per-room topics) → tag **v1.0.0** — later.

**Deferred, do NOT pick up:** M8-C4 (score reveal + session leaderboard). Parked deliberately;
revive only if the owner says so.

**Environment ceilings — flag these, don't fight them:** LRCLIB unreachable; no microphone (scoring
is exercised with a synthesized pitch stream); Demucs/WhisperX take ~1–2 min/song on CPU; YouTube
autoplay-with-audio needs a real user gesture, and YouTube embeds are refused in headless Chromium
on this box (that's the environment, not a bug).

---

## 8. How to verify (this is not optional)

The whole recent bug history is *unit tests green while production is broken*. Four examples, all
found only by driving the real app:

| Defect | Why tests missed it |
|---|---|
| A plain queue add never started playback — TV stuck on attract forever | the feature was never *wired* to a trigger |
| `WsClient` passed bare `setTimeout` as an option → `Illegal invocation` in a browser, so the heartbeat and auto-reconnect were **silently dead in production** | tests injected fake timers |
| An `add` with a missing `singerId` **killed the server process** | no test sent a malformed field |
| The phone announced "No karaoke-ready songs yet" with 5 songs in the library | the copy was never asserted against a populated library |

So: **AUTO gates** (`bun test` from `apps/core`, `pytest`, `bun run typecheck`, `bun run build`) are
the floor, not the bar. Then drive it:

1. Boot the built server on 127.0.0.1:5180 (§3), with the worker container up if stems are in play.
2. Drive real browser contexts with playwright (Node 20) — join → search → queue → TV.
3. **Prefer assertions over pixels** for anything textual or numeric: read `innerText`, input values,
   element counts, DOM geometry. Screenshot for *look*, assert for *truth*. Watch for case: CSS
   `text-transform` means `innerText` returns "NOW SINGING", so match case-insensitively.
4. A **direct WS probe** (a Bun script opening `ws://127.0.0.1:5180/ws?role=phone`) is the decisive
   ground truth when browser/tab state is confusing.
5. Add the surface to the dev **`/components`** gallery so it has a stable eyes-on home, and drop the
   verified frame in `docs/mocks/` as `<id>-<what>-eyeson.png`.
6. `curl /api/me` from a shell returns null — no session cookie. Not a bug.

Record what you verified in the ROADMAP item, split **AUTO** vs **EYES-ON**, and be honest when
something can only be flagged for a human (audio, real ML, network-dependent).

---

## 9. Doc index

| Doc | What it's for |
|---|---|
| `docs/MASTER-DESIGN.md` | The consolidated design — read first |
| `docs/reconciliation-contract.md` | Optimistic-UI + diff-broadcast contract (the invariant) |
| `docs/tv-preload-state-machine.md` | Gapless TV two-player state machine |
| `docs/job-lifecycle-and-worker-protocol.md` | Job ledger + dial-home worker protocol |
| `docs/performance-and-feel.md` | What makes it feel instant |
| `docs/ROADMAP.md` | Commit-level plan M0→M9 **+ the live backlog queue** |
| `docs/media-storage-spec.md` | **B-7** storage classes, sidecar metadata, tagging, retention |
| `docs/vocal-guide-spec.md` | Specced, deferred feature |
| `docs/mocks/` | Phone/TV mocks + the eyes-on screenshot per milestone |
| `README.md` | User-facing quickstart |
