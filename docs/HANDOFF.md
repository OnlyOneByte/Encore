# Encore — Agent Handoff

> **Purpose.** The single onboarding doc for an agent (or human) picking up Encore cold. What's
> built, how to run and test it without tripping the traps, what's unpushed, and where to start next.
>
> **Last updated:** 2026-09-02 · **State:** `v0.2.0` (stems) shipped; M0–M8 closed; on the backlog.
> **Read this first, then:** `docs/MASTER-DESIGN.md` → `docs/ROADMAP.md` → the two contracts
> (`reconciliation-contract.md`, `job-lifecycle-and-worker-protocol.md`).

---

## 0. TL;DR for the next agent

- **Everything through M8 is done.** MVP (`v0.1.0`), make-karaoke/stems (`v0.2.0`), scoring
  (M8-C0–C3). Both tags are **local only**.
- **273 core tests + 35 shared tests pass** — core tests **must** run from `apps/core/` (Gotcha #1).
  `svelte-check`: 0 errors.
- **Unpushed: 5 commits + both tags.** A human must push (§5).
- **Next work is the backlog, not a milestone.** Start at **B-2** (WebAudio pitch-shift) — see §7.
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
# --- tests (MUST cd into apps/core, see Gotcha #1) ---
cd apps/core && bun test            # → 273 pass / 0 fail
bun run typecheck                   # svelte-check → 0 errors
cd packages/shared && bun test      # → 35 pass

# --- the worker ---
cd apps/worker && pytest

# --- dev / prod ---
cd apps/core
bun run build && bun run start      # prod build + serve
bun run dev                         # vite HMR for UI ONLY — the WS hub lives in server.ts

# --- container ---
docker compose up                   # core only
docker compose --profile stems up   # + the Python worker
```

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

1. **Run `bun test` from `apps/core/`, not the repo root.** The DB tests resolve `./drizzle`
   relative to cwd; from the root you get `Can't find meta/_journal.json` and ~11 spurious failures.
   (Real fix if you care: resolve migrations via `import.meta.dir`.)
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
9. **`bun run typecheck` from the repo ROOT exits 127** (tsc not on PATH for `@encore/shared`).
   Environment, not code — run it inside `apps/core`.
10. **Stage files explicitly; never `git add .`** — `.kiro/` is local tooling and must stay
    untracked. And **check `git status` after committing**: a B-6 commit shipped without its
    `packages/shared` contract change and was not buildable in isolation, because the local
    verification ran on a working tree the commit didn't describe.
11. **Node 20 for `playwright-cli`/playwright** — `export PATH="$HOME/.local/share/mise/installs/node/20.20.2/bin:$PATH"`.
12. **Cap eyes-on screenshots at ≤2000px** (1280×720 viewport, `deviceScaleFactor: 1`). An oversized
    image hard-fails the agent turn and keeps re-firing from history.

---

## 5. Git state & the push blocker ⚠️

- Branch `main` is **6 ahead** of `origin/main` (which is at `42276a8`).
- Unpushed: `36957c3` (v0.1.0 review fixes), `eafb1cc` (B-1), `d2a64c1` (B-5), `9506018` (B-6),
  `0af80b4` (B-6's omitted shared contract), `67be7f2` (library empty-state fix), and this doc refresh.
- **Tags `v0.1.0` and `v0.2.0` are local-only.**
- `9506018` and `0af80b4` are a broken-commit + its fixup. **Squash them before pushing** if clean
  history matters; nothing is pushed, so it's free to do.

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
