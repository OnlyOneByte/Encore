# Encore — Agent Handoff

> **Purpose.** This is the single onboarding doc for an agent (or human) picking up Encore cold.
> It tells you what's built, how to run/test it without tripping the known gotchas, what's still
> on the remote-push hook, and exactly where to start the next milestone (M7 — stems).
>
> **Last updated:** 2026-06-30 · **State:** v0.1.0 MVP shipped & tagged locally.
> **Author of this handoff:** prior agent session (continuation of the build-to-MVP work).

---

## 0. TL;DR for the next agent

- The MVP is **done, working, and committed.** `docker compose up` runs the whole thing.
- **117 tests pass / 0 fail** — but **only when run from `apps/core/`** (see Gotcha #1). From the
  repo root, 11 DB tests fail on a cwd-relative migrations path. This is *not* a regression.
- `svelte-check`: **0 errors, 0 warnings.**
- **One commit is unpushed** (`36957c3`) and the **`v0.1.0` tag is not on the remote.** The push is
  blocked by the MeshClaw harness git-push guard — a human must run `git push` (see §5).
- Next real work is **M7 (make-karaoke / stems)** — start at **M7-C1** (jobs ledger). See §7.
- **Read these first, in order:** `docs/MASTER-DESIGN.md` → `docs/reconciliation-contract.md` →
  `docs/job-lifecycle-and-worker-protocol.md` → `docs/ROADMAP.md`.

---

## 1. What Encore is

Self-hosted, mobile-first karaoke webserver (personal project, `github.com/OnlyOneByte/Encore`).
Scan a QR on your phone → pick a name+color (no signup) → search YouTube or a local library →
one-tap queue. A TV/stage surface plays videos **gaplessly** with a round-robin rotation
(everyone's 1st pick before anyone's 2nd). Roadmap adds **make-karaoke** (Demucs stem separation
to strip vocals on demand), scoring, and optional accounts.

Design pillars: **UI-first, wicked-fast/optimistic, as close to one container as possible.**

---

## 2. Tech stack (locked — don't re-litigate)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Bun 1.3.14** (user-local `~/.bun`, aarch64/AL2) | native WS pub/sub, `bun:sqlite`, `Bun.spawn`, `Bun.file` |
| Web framework | **SvelteKit + Svelte 5 runes** + PWA | `svelte-adapter-bun@1.0.1` → `getHandler() → {fetch, websocket}` |
| Bundler | **Vite 8** | `bun --bun` flag is **required** (else SvelteKit defers to Node 18) |
| ORM / DB | **Drizzle 0.45.2 + drizzle-kit**, `bun:sqlite` (WAL) | migrations in `apps/core/drizzle/`, applied at boot |
| Monorepo | **Bun workspaces** | `packages/shared` = the contract; `apps/core`; `apps/worker` (Python, behind `stems` profile) |
| Worker | **Python + Demucs + WhisperX** | container 2, dial-home WS client. Scaffold only today. |

**The case for Bun was made and accepted; it's locked.** Do not propose Node/Deno swaps.

### Repo layout
```
Encore/
├─ package.json            # workspace root: scripts dev/build/test/typecheck
├─ bun.lock
├─ .npmrc                  # repo-local — pins PUBLIC npm (see Gotcha #2)
├─ docker-compose.yml      # core (always) + worker (profile: stems). Hardened (see §6).
├─ docs/                   # MASTER-DESIGN, reconciliation-contract, ROADMAP, this file, mocks/
├─ packages/shared/        # @encore/shared — types, ops, rotation reducer, events, ulid, colors
│   └─ src/{types,ops,rotation,events,ulid,colors,index}.ts (+ *.test.ts)
└─ apps/
    ├─ core/               # @encore/core — the SvelteKit app + server
    │   ├─ server.ts       # entrypoint: Bun.serve, wires SvelteKit handler + WS hub
    │   ├─ drizzle/        # migrations 0000 + 0001 (+ meta/_journal.json)
    │   ├─ src/server/     # app.ts (singleton), db/, realtime/, state/, media/, rotation/, singers/
    │   ├─ src/lib/        # stores/ (queue), ws/ (client), tv/ (gapless), components/
    │   └─ src/routes/     # +page (phone), tv/, join/, api/{join,me,search,thumb}, media/[...path]
    └─ worker/
        └─ src/dial_home.py  # SCAFFOLD only — full impl is M7-C4
```

---

## 3. How to run & test (READ THE GOTCHAS in §4 FIRST)

```bash
# bun is NOT on the non-interactive PATH — add it:
export PATH="$HOME/.bun/bin:$PATH"

# --- tests (MUST cd into apps/core, see Gotcha #1) ---
cd apps/core && bun test          # → 117 pass / 0 fail
bun run check                     # svelte-check → 0 errors

# --- shared package tests ---
cd packages/shared && bun test

# --- dev / prod ---
cd apps/core
bun run dev                       # vite HMR for UI (WS hub needs the built server though)
bun run build && bun run start    # prod build + serve on :3000

# --- whole thing in a container ---
docker compose up                 # core only (the MVP)
docker compose --profile stems up # + the Python worker (M7+, not functional yet)
```

When serving HTTP for eyes-on verification, **bind to 127.0.0.1 only** (standing constraint).

---

## 4. Gotchas (the traps that will cost you an hour each)

1. **Run `bun test` from `apps/core/`, not the repo root.** The DB/migration/singers/state tests
   resolve `./drizzle` (and `meta/_journal.json`) **relative to cwd**. From the root you get
   `error: Can't find meta/_journal.json file` and **11 spurious failures**. They are NOT real —
   from `apps/core` it's a clean 117/0. (If you want a root-level `bun test` to pass, the fix is to
   make `runMigrations` resolve the migrations folder relative to the module via
   `import.meta.dir`/`fileURLToPath` instead of the default `'./drizzle'`. Optional cleanup, not
   blocking.)

2. **`.npmrc` is repo-local and pins PUBLIC npm on purpose.** This is a corp box; the *global*
   npmrc points at CodeArtifact and returns **401** for public packages. Do not delete the
   repo-local `.npmrc`, and don't `npm config set` globally.

3. **`bun --bun` is mandatory** for SvelteKit/Vite commands. Without it, SvelteKit's CLI shebang
   defers to the system Node 18 and things break subtly. The package scripts already include it —
   use `bun run <script>`, don't call `svelte-kit`/`vite` raw.

4. **`globalThis`-backed singleton.** `getApp()` / `setPublish()` live in `apps/core/src/server/app.ts`
   behind a `globalThis` symbol, reached via the `$server` Vite alias. This is **deliberate**: the
   SvelteKit request handler is a *separate bundle* from `server.ts`, so a plain module-level
   singleton would split-brain (this bug was hit & fixed in M4-C4 — see commit `870bf36`). If you
   add server-side singletons, route them through `app.ts`, not module scope.

5. **`.gitignore` `data/`/`media/` are ANCHORED (`/data/`, `/media/`) on purpose.** An un-anchored
   `media/` previously matched `src/server/media/` and `src/routes/media/` and **silently excluded
   the entire M4 search subsystem from git** (14 files). If you add ignore rules for runtime dirs,
   **anchor them with a leading `/`.** See the comment in `.gitignore`.

6. **Don't kill processes by broad pattern.** `pkill -f 'bun ...'` can self-match the harness. Use
   `lsof -ti tcp:3000 | xargs -r kill` to free the port.

7. **Destructive commands are denied by the harness** (`rm -rf`, `DROP TABLE`, etc.) and so is
   `git push` (see §5). Don't try to script around these — the guards catch substitution/script
   evasion. Surface the blocker to the human instead.

---

## 5. Git state & the push blocker ⚠️

- Branch `main` is **ahead 1** of `origin/main` (which is at `42276a8`).
- **Unpushed commit:** `36957c3` — *"review: fix auth/media/Docker findings + CRITICAL un-tracked
  media subsystem."*
- **The `v0.1.0` tag is local-only** — `git ls-remote --tags origin` is empty.
- Working tree is **clean**; a read-only fetch confirmed **no divergence** (cleanly 1 ahead, nothing
  to pull).

**A `git push` cannot be run by the agent** — it's blocked by MeshClaw's hardcoded harness guard
(`_is_git_publish` in `security.py`, with an anti-evasion regex). A **human must run:**

```bash
cd /local/home/angryang/.meshclaw/workspace/Encore
git push origin main
git push origin v0.1.0     # tag is not on the remote yet
```

> Durable unblock (optional, separate task): set `MESHCLAW_ALLOW_GIT_PUSH=1` in the **gateway
> process env** and restart the gateway. It reverts on `meshclaw update`. This is a personal
> project, so this exception is permitted — but it's not configured in this session.

---

## 6. Architecture & invariants you must not break

### The reconciliation contract (the heart of "wicked fast")
Full spec: `docs/reconciliation-contract.md`. The invariant:

> **`client.predict(op) === server.apply(op)` for EVERY mutation path**, including round-robin
> resequencing.

- **Client-minted ULID** per op; server holds a **monotonic `rev`**.
- Client keeps a **pending-op Map**; on reject it applies the **inverse op** to roll back.
- Server broadcasts **diff/patch** (`queue:patch`) carrying `{rev, ops, causedBy, entries, media}`.
  The authoritative pruned/reseq'd snapshot rides **inline** in the patch (`entries`/`media`) so a
  single `queue:patch` replaces the old patch+sync pair. Client adopts `entries` authoritatively and
  rebases pending ops.
- **Rev-gap detection** on the client → triggers a resync.
- The shared reducer is **`packages/shared/src/rotation.ts`** — `applyAndReseq(entries, op)` is used
  by BOTH the server (`store.ts`) and the client optimistic path (`queue.ts`). Keep them on the same
  function or the invariant breaks. `move` → `reorderWithinSinger` (permutes `addedAt` within a
  singer's picks). `addedAt` is monotonic on the client (`#nextAddedAt()`).

### Rotation
Round-robin: `rotate` / `assignSeqs` / `applyAndReseq`. Terminal entries (`done`/`canceled`) are
**pruned** on apply and hydrate (`isTerminal`). The **held-slot rule** (keep a singer's seq while
their make-karaoke song cooks, slot it back when ready) is **specced but its real impl is M7-C6** —
today nothing holds slots because nothing cooks yet.

### Gapless TV
Two-player swap: player **A visible / B warming**, swap on `ended`. Telemetry-driven `advance()`.
Code: `apps/core/src/lib/tv/gapless.ts` + `TvPlayer.svelte`; server side `realtime/player.ts`.
Spec: `docs/tv-preload-state-machine.md`.

### Container hardening (already applied)
`docker-compose.yml` has an `x-hardening` anchor: `no-new-privileges:true` + `cap_drop: [ALL]` on
core & worker. Dockerfile runs **non-root `bun`**, pins `yt-dlp` (`YT_DLP_VERSION`), and pins the
base image. Don't regress these.

### Security posture (from the review pass — keep these intact)
- **SSRF guard** on the thumbnail proxy: `isAllowedThumbUrl` host allowlist + https-only
  (`server/media/thumbs.ts`). Blocks metadata IP / localhost / internal.
- **Path-traversal guard** on `/media`: `safeMediaPath` resolves-under-base, rejects `../`,
  absolute, NUL, `%2e`-encoded, sibling-prefix (`media-evil`), and `.thumbs`
  (`server/media/local-files.ts`).
- **Session token** has a `uniqueIndex` (migration `0001`).
- **yt-dlp**: query passed as a single argv element (no shell injection); kill-timer on hung
  searches; negative-availability TTL re-probe.

---

## 7. Where to start next: M7 — make-karaoke (stems) → v0.2.0

This is the headline "smart feature." It's **container 2** (the Python worker), gated behind the
`stems` compose profile, so it never blocks the single-container MVP. Full design:
`docs/job-lifecycle-and-worker-protocol.md`. Build order (from `docs/ROADMAP.md`):

- **M7-C1** ★ **START HERE.** Jobs ledger (`src/server/jobs`): Drizzle `jobs` table, dedup on
  `(mediaId, jobType)`, state machine `queued→assigned→running→ready/failed/canceled`.
  *Done-when:* unit test covers full lifecycle + dedup + idempotent re-add.
- **M7-C2** Leases + reaper (ack 10s / progress 30s); boot resets `assigned`/`running`→`queued`.
- **M7-C3** Dial-home protocol on core: `worker:hello/heartbeat`, dispatch by priority
  (`=rotationSeq`), `job:assign/accept/progress/complete/failed`. *Done-when:* a fake worker socket
  drives a job to `ready`.
- **M7-C4** Worker container: finish `apps/worker/src/dial_home.py` (today it's a scaffold — connects
  + sends `worker:hello` only), add `apps/worker/Dockerfile` (torch+ffmpeg).
- **M7-C5** Demucs `htdemucs` → instrumental written to MediaStore.
- **M7-C6** `playMode` flip iframe→file on `ready`; **real held-slot** rotation impl.
- **M7-C7** Live progress UI: `media:status` → `ProcessingCard` bar + stage chips.
- **M7-C8** WhisperX align → word-timed lyrics. **M7-C9** ±key pitch shift.
- **M7-C10** MediaStore `object` (MinIO/S3) impl for remote workers. **M7-C11** tag `v0.2.0`.

After M7: **M8 scoring** (v0.3.0), **M9 accounts** (v1.0.0, additive — never gates the party).

### Working conventions (match the existing code)
- **One commit per roadmap sub-task**, message prefixed `M7-C1: …`. Each is self-contained &
  buildable. Look at `git log --oneline` for the established style.
- **TDD-ish:** every commit lands with tests; "Done-when" in the roadmap is the acceptance bar.
- Pure logic separated from I/O so it unit-tests without the binary (see `ytdlp.ts`'s
  `parseSearchJson` split — copy that pattern for Demucs/WhisperX parsing).
- Commits use the **personal `OnlyOneByte`** git identity (same as VROOM).

---

## 8. MeshClaw task tracking

Milestones are mirrored as MeshClaw tasks (TaskList): **M0–M6 completed**, **M7/M8/M9 pending**.
When you start M7, set task #8 to `in_progress`; flip to `completed` at the `v0.2.0` tag.

---

## 9. Doc index

| Doc | What it's for |
|---|---|
| `docs/MASTER-DESIGN.md` | The consolidated design — read first |
| `docs/reconciliation-contract.md` | Optimistic-UI + diff-broadcast contract (the invariant) |
| `docs/tv-preload-state-machine.md` | Gapless TV two-player state machine |
| `docs/job-lifecycle-and-worker-protocol.md` | M7 job ledger + dial-home worker protocol |
| `docs/performance-and-feel.md` | What makes it feel instant |
| `docs/ROADMAP.md` | Commit-level plan, M0→M9 |
| `docs/mocks/` | Phone/TV UI mocks + eyes-on screenshots per milestone |
| `README.md` | User-facing quickstart |
