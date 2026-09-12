# Encore — Agent Handoff

> **Purpose.** Onboarding for an agent or human picking up Encore cold: the traps, the invariants you
> must not break, how to run it, and how to verify. **What to build next is NOT here** — open work is
> tracked in **GitHub issues**; ratified decisions and the parked scope fence are in
> [`DECISIONS.md`](DECISIONS.md).
>
> **Reading order:** [`ARCHITECTURE.md`](ARCHITECTURE.md) → this file → [`DECISIONS.md`](DECISIONS.md).
>
> **State:** `v0.2.0` (stems) shipped; the saved-library, media-storage, key-shift and two-tier lyrics
> work are done. The current large item is the separator swap to `python-audio-separator`.

Self-hosted, mobile-first karaoke (personal project, `github.com/OnlyOneByte/Encore`). Scan a QR →
name+color, no signup → search → one-tap queue. A TV surface plays **gaplessly** with round-robin
rotation. **Make-karaoke** strips vocals via Demucs; word-timed lyrics and live pitch scoring ride on
the stems. Pillars: **UI-first, wicked-fast/optimistic, as close to one container as possible.**

---

## 1. Three things that will bite you first

- **A worker is a separate process.** Core alone accepts a make-karaoke request and leaves it at
  `queued` **forever**, with no warning in the UI.
- **A green suite is the floor, not the bar.** Every real defect found lately was invisible to
  passing tests and only surfaced by driving the app (§5). Never report a feature working on unit
  tests alone.
- **Agents CAN push** — see Gotcha 7. Older notes in this repo claimed otherwise and were wrong.

---

## 2. Stack (locked — don't re-litigate)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | **Bun 1.3.14** | native WS pub/sub, `bun:sqlite`, `Bun.spawn` |
| Web | **SvelteKit + Svelte 5 runes** + PWA | `svelte-adapter-bun` → `getHandler()` |
| Bundler | **Vite 8** | `bun --bun` is **required** |
| DB | **Drizzle + `bun:sqlite`** (WAL) | migrations in `drizzle/`, applied at boot |
| Monorepo | **Bun workspaces** | `src/lib/contract` = the contract; `.`; `worker` |
| Worker | **Python + Demucs + WhisperX** | container 2, dial-home WS client |

The case for Bun was made and accepted. Do not propose Node/Deno swaps.

```
Encore/
├─ docker-compose.yml     # core (always) + worker (profile: stems)
├─ docs/                  # ARCHITECTURE, HANDOFF, DECISIONS; deploy/, benchmarks/, mocks/, research/
├─ src/lib/contract/       # $lib/contract — types, ops, rotation reducer, events, ulid, colors
└─ apps/
    ├─ core/              # @encore/core — SvelteKit app + server
    │   ├─ server.ts        Bun.serve entry: HTTP + WS hub + presence + worker transport
    │   ├─ src/server/      app.ts (singleton), db/, realtime/, state/, media/, jobs/, rotation/, singers/
    │   ├─ src/lib/         stores/, ws/, tv/ (gapless, lobby, lyrics), components/
    │   └─ src/routes/      +page (phone), tv/, join/, components/ (dev gallery), api/
    └─ worker/             # dial_home.py + Demucs/WhisperX processors + pytest
```

---

## 3. Running it

**Run it.**
```bash
cd . && bun run build
PATH="/home/angryang/.local/share/mise/installs/python/3.12.13/bin:/home/angryang/ffmpeg:$PATH" \
  HOST=127.0.0.1 PORT=5180 bun run server.ts
```
`yt-dlp` is invoked **by name via PATH**, so that directory must be on PATH or YouTube search silently
returns empty. The worker is a separate process — `docker compose --profile stems up`, or the
long-lived `encore-worker-live` container.

Other entry points:
```bash
bun run build && bun run start      # prod build + serve; `start` → server.ts
bun run dev                         # vite HMR for UI ONLY — the WS hub lives in server.ts
docker compose up                   # core only
docker compose --profile stems up   # + the Python worker
```

**Verification gates — run all five on every change.**
```bash
bun test                              # core + shared — runs from the REPO ROOT
cd worker && python3 -m pytest   # worker suite
bun run typecheck && bun run build    # both workspaces; typecheck must be 0 errors / 0 warnings
bun run gate:measured                 # the layout rung — AFTER build; boots its own server + Chromium
```
`runMigrations()` locates `drizzle` by walking up from `import.meta.dir`, so `bun test`
works from anywhere. Re-measure the counts every time — they drift as tests land.

**A green suite is the floor, not the bar.** Every real defect in this project so far was invisible to
a passing suite and only surfaced by driving the app (§5). Anything with a rendered surface needs
eyes-on; screenshots live in `docs/mocks/` as `<id>-<what>-eyeson.png`.

**Environment ceilings — flag these, do not fight them.**
- `lrclib.net` fails DNS outright (`gaierror`) **on this laptop only**; `huggingface.co` and
  `www.youtube.com` resolve from the same shell — a box property, not a project fact, hence
  `ENCORE_LRCLIB_BASE`. WhisperX models **do** download, so real-ML lyrics work is verifiable here.
- Demucs/WhisperX run in the worker container, ~1–2 min/song on CPU.
- Host ffmpeg (`/home/angryang/ffmpeg/ffmpeg`) is a **stripped 7.1.1 build**: no AAC encoder, no mp4
  muxer, no `ffprobe`. Use the **container's** ffmpeg (`docker exec`) for probing and transcoding.
- A long-lived Python process does **not** reload bind-mounted source; `docker restart` after editing
  worker code.
- YouTube autoplay-with-audio needs a user gesture in-browser.

`data/` and `media/` are created on first boot, so a fresh clone needs no setup. `ENCORE_EPHEMERAL=1`
swaps in an in-memory DB.

**The worker without Docker:**
```bash
cd worker && python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
PATH="$PWD/.venv/bin:$PATH" ENCORE_CORE_WS='ws://localhost:3000/ws?role=worker' \
  MEDIA_DIR=../core/media \
  .venv/bin/python -m src.dial_home
```
Those two variables are the whole configuration — no capability list, no device. The worker probes its
own hardware and installed engines at startup and prints both, one line per capability with the
evidence; a missing tool is reported as loudly as a present one. It shells out to
`yt-dlp`/`ffmpeg`/`demucs` **by name via PATH**, so that prefix is load-bearing — and it is also what
the capability probe checks, so a venv the worker cannot see means capabilities it will not claim.
Launching **core** with the same venv `bin` on PATH also gives core its `yt-dlp`, so YouTube search
starts returning results. `MEDIA_DIR` must be the SAME dir core uses, or core marks a job complete for
a file it cannot serve. `ENCORE_PROCESSOR=stub` walks the whole assign→complete→ready path with
**placeholder files that will not play** — plumbing only.

**Sharing with the owner:** `tunnel create 5180 --name encore` →
`https://angryang-encore.v.tunnels.lab.aws.dev` (Midway, owner-only). Tunnel the **built** server,
never `vite dev`. The tunnel agent dies on its own sometimes; the server survives it.

---

## 4. Gotchas (each one costs an hour)

0. **`/metrics` is empty for songs cooked before the attempt ledger shipped, and that is correct.**
   Processing history lives in `job_attempts`, which only starts recording when it is deployed — the
   durations of past cooks were never written down and are not recoverable. A song with no history
   says so explicitly on its audit page rather than reading as "never processed". Related: `/metrics`
   and `/api/audit/*` are **ungated** by decision (there is no operator identity in Encore; any LAN
   phone can self-join), so treat them as LAN-visible. See ARCHITECTURE §10 (gating this is open work).
   Also: a fresh git worktree has no `node_modules`, so `bun test` reports ~39 phantom failures on
   `$lib/contract` until you run `bun install`.
1. **`.npmrc` is repo-local and pins PUBLIC npm on purpose.** The *global* npmrc points at
   CodeArtifact and 401s for public packages. Don't delete it; don't `npm config set` globally.
2. **`bun --bun` is mandatory** for SvelteKit/Vite. Use `bun run <script>`; never call `vite` raw.
3. **`globalThis`-backed singleton.** `getApp()`/`setPublish()` in `src/lib/server/app.ts` behind a
   `globalThis` symbol, via the `$lib/server` alias. **Deliberate** — the SvelteKit handler is a *separate
   bundle* from `server.ts`, so a module-level singleton split-brains (two queues, two DBs). Route
   every new server singleton through `app.ts`.
4. **`.gitignore` runtime dirs are ANCHORED (`/data/`, `/media/`).** An un-anchored `media/` once
   matched `src/lib/server/media/` and silently excluded the whole search subsystem from git.
5. **Don't kill processes by broad pattern.** `pkill -f 'bun ...'` can self-match the harness. Use
   `lsof -ti tcp:5180 | xargs -r kill`.
6. **Stage files explicitly; never `git add .`** — `.kiro/` is local tooling and stays untracked. And
   **check `git status` after committing**: a commit once shipped without its `src/lib/contract`
   contract change and was not buildable in isolation, because local verification ran on a working
   tree the commit didn't describe.
7. **Pushing works — with a bare `git push origin HEAD:refs/heads/<branch>` from the repo root, no
   env prefix and no pipe.** This was misdiagnosed for a long time: the guard pattern-matches an inline
   `MESHCLAW_ALLOW_GIT_PUSH=1` assignment, so **adding that env var is what blocked the push**, and
   the failure reads misleadingly as "User denied tool execution". Do not add it. `rm -rf` and
   `DROP TABLE` are genuinely blocked; surface a blocker rather than routing around it.
8. **`bun:sqlite` UNRESOLVED_IMPORT during `bun run build` is harmless** — Bun resolves built-ins at
   runtime.
9. **Node 20 for `playwright-cli`** —
   `export PATH="$HOME/.local/share/mise/installs/node/20.20.2/bin:$PATH"`.
10. **Cap eyes-on screenshots at ≤2000px** (1280×720 viewport, `deviceScaleFactor: 1`). An oversized
    image hard-fails the turn and keeps re-firing from history.
11. **`soundfile` is REQUIRED for stems, and its absence looks like a hang.** torchaudio 2.8 has no
    audio-write backend, so demucs separates to **100%** and *then* dies with `Couldn't find
    appropriate backend to handle uri .../vocals.wav`. It reaches you as a song frozen at
    "separating 100%" that silently retries 3× — a full separation pass each time. Now pinned in
    `requirements.txt`; before that it arrived only transitively via `whisperx`, so a stems-only
    worker was broken while the full install worked.
12. **A `failed` job leaves the media stuck showing `queued`/cooking forever.** Nothing surfaces the
    error to the phone or TV and terminal jobs are never retried. Recover by deleting the failed row
    from `jobs` and resetting that media's `stem_status` to `none` — dedup is on `(mediaId, jobType)`,
    so a re-tap alone won't re-enqueue. Worth a real fix.
13. **Read the `jobs` table when a cook misbehaves** — its `error` column is often the ONLY place the
    message exists. The column is `error`, not `last_error`.
14. **Not every YouTube video downloads.** yt-dlp hits `This video is not available` on some ids and
    the job fails at stage `downloading` after 3 attempts. That is upstream bot-checking, not an
    Encore bug — try another video before debugging.
15. **An ephemeral `PlaybackState` field LEAKS across songs unless you name it three times.** That
    object is a long-lived singleton — nothing rebuilds it per song — so each per-song field is
    cleared by being listed at three separate `setPlayback` calls in `realtime/player.ts`: `advance()`
    (reached by an explicit skip **and** by TV `ended` telemetry), the play-from-idle branch, and
    `reconcileOnReady`. Miss one and the previous singer's choice carries into the next turn. The type
    checker cannot catch it, so test each path separately — `realtime/background.test.ts` has one test
    per path for exactly this reason. Fields with this shape today: `keyShift`, `background`.
16. **Nothing above z-index 0 on the TV may paint an opaque background.** `TvPlayer`'s `<video>` used
    to carry `background: #000`; with `object-fit: contain` and a video-less instrumental that painted
    the entire screen and hid the stage background completely. If a new TV layer looks like it "isn't
    rendering", check what is painting over it before checking your own code — and see
    ARCHITECTURE §4 for the full stacking contract.
17. **`server.ts` serves the BUILT bundle, so a source edit is invisible until you rebuild.** Tuning a
    renderer and re-screenshotting gave byte-identical frames twice before this was obvious — the
    capture was of the previous build. `bun run build` between an edit and an eyes-on capture, always.
18. **Routing a `<video>` into a Web Audio graph SILENCES it unless you reconnect `destination`.** No
    audio graph exists on the TV yet, so this is a trap waiting for whoever adds one. Note the phone's
    mic code deliberately does the opposite — `mic-capture.ts` connects source→analyser and *not* to
    destination, on purpose. Copying that pattern onto the TV is exactly the bug, the symptom is a
    silent karaoke party, and no unit test catches it.

---

## 5. How to verify (not optional)

The recent bug history is *unit tests green while production is broken*. All four found only by
driving the real app:

| Defect | Why tests missed it |
|---|---|
| A plain queue add never started playback — TV stuck on attract forever | the feature was never *wired* to a trigger |
| `WsClient` passed bare `setTimeout` as an option → `Illegal invocation` in a browser, so heartbeat and auto-reconnect were **silently dead in production** | tests injected fake timers |
| An `add` with a missing `singerId` **killed the server process** | no test sent a malformed field |
| The phone announced "No karaoke-ready songs yet" with 5 songs in the library | the copy was never asserted against a populated library |

So, after the AUTO gates pass:

1. Boot the built server on 127.0.0.1:5180, worker container up if stems are in play.
2. Drive real browser contexts with playwright (Node 20) — join → search → queue → TV.
3. **Prefer assertions over pixels** for anything textual or numeric: `innerText`, input values,
   element counts, DOM geometry. Screenshot for *look*, assert for *truth*. Mind case — CSS
   `text-transform` means `innerText` returns "NOW SINGING", so match case-insensitively.
4. A **direct WS probe** (a Bun script opening `ws://127.0.0.1:5180/ws?role=phone`) is the decisive
   ground truth when browser/tab state is confusing.
5. Add the surface to the dev **`/components`** gallery, and drop the verified frame in `docs/mocks/`
   as `<id>-<what>-eyeson.png`.
6. `curl /api/me` from a shell returns null — no session cookie. Not a bug.

Record what you verified on the issue, split **AUTO** vs **EYES-ON**, and be honest when
something can only be flagged for a human (audio, real ML, network).

---

## 6. Invariants you must not break

**Nothing plays unprocessed.** A `Media` is one downloaded rendition, and it is playable only when it
has a separated instrumental — `stemStatus === 'ready'` **and** an `instrumentalRef`, both, because the
two are written by separate steps and a status running ahead of its artifact hands the player an empty
source. There is no YouTube embed path and no raw-source path; a local library file is a cook candidate
like any other source. `playbackRef` returns `''` for anything uncooked and `isPlayable` is defined in
terms of it, so "what do I load" and "is there anything to load" cannot disagree. Readiness is
`ready` / `cooking` / `unacquired`.

**Acquisition is declared, never inferred.** A job carries `params.fetcher` (`ytdlp` or `local`) and the
worker parses it at its boundary. Do not reintroduce a test on the URI's shape: an `http(s)` prefix check
lived in three places and silently classified anything else as a local file, dying stages later inside
ffmpeg with "No such file".

**A citation never regresses.** Once a media holds a `high` MusicBrainz annotation, a later `medium`
must not overwrite it — in memory, in the DB, or on a sidecar write that re-parses the raw title. All
three paths have to hold or a restart quietly turns a cited artist back into a guess.

**The reconciliation contract** (canonical explanation: [`ARCHITECTURE.md`](ARCHITECTURE.md)):

> **`client.predict(op) === server.apply(op)` for EVERY mutation path**, including round-robin resequencing.

Client-minted ULID per op; server holds a monotonic `rev`; client keeps a pending-op Map and applies
the inverse on reject; server broadcasts `queue:patch{rev, ops, causedBy, entries, media}` with the
authoritative snapshot **inline**; rev-gap detection triggers resync. The shared reducer
`src/lib/contract/queue/rotation.ts` (`applyAndReseq`) runs on **both** sides — keep them on the same
function or the invariant breaks.

**Validate every field a client sends.** An `add` with a missing `singerId` once reached the
`NOT NULL singer_id` write and threw out of `state.apply()`, **killing the whole server process** —
one malformed message could end a party. Validation lives in `hub.ts:validateCommand`.

**Rotation.** `rotate` / `assignSeqs` / `applyAndReseq`. Terminal entries (`done`/`canceled`) are
pruned on apply and hydrate. The **held-slot rule** — a singer keeps their seq while their song cooks
— is real: a not-yet-ready `file` entry is skipped by `isEntryReady` but keeps its seq.

**Media identity** (learned the hard way). `sourceRef` is **immutable origin identity**; the
cooked stem key lives in `Media.instrumentalRef` and players ask `playbackRef(media)` what to load.
Overwriting `sourceRef` on cook made a song unmatchable against its own search result forever, so
every search minted a fresh uncooked duplicate.

**Presence.** The WS upgrade resolves which singer a socket belongs to from the session cookie; a
ref-counted `PresenceTracker` broadcasts `singer:presence{online}` on 0→1 and 1→0 only, and
`queue:sync` carries an `online` snapshot for mid-party joiners. **Never use the `singers` table as
"who's here"** — it is append-only and file-backed, so it accumulates everyone who ever joined.

**TV surfaces.** Four states via the pure `tvScreen()` in `src/lib/tv/screen.ts`, precedence
`playing > waiting > lobby > attract`: **attract** (nobody here, full-screen QR), **lobby** (people,
nothing queued — hero QR + roster strip), **waiting** (queued, still cooking), **playing**. **The
join card is bottom-right and must stay there** — the lower-third owns bottom-left.

**Gapless TV.** Two-player swap (A visible / B warming, swap on `ended`), telemetry-driven
`advance()`. `src/lib/tv/gapless.ts` + `TvPlayer.svelte`; server side `realtime/player.ts`.

**Jobs & the worker.** Ledger with dedup on `(mediaId, jobType)`, leases + reaper (ack 10s /
progress 30s), boot recovery resets orphaned `assigned`/`running` → `queued`. Workers dial home over
WS and advertise capabilities. A completed `stems` job chains `align` via
`followUps()` in `jobs/dispatch.ts` — depth-1 fan-out, because the ASR stage reads the
**vocals stem**, which does not exist until stems finishes.

Both flows are canonical in [`ARCHITECTURE.md`](ARCHITECTURE.md).

**Security posture (keep intact).** SSRF host-allowlist + https-only on the thumb proxy;
path-traversal guard on `/media` (`safeMediaPath`, containment per storage root); `uniqueIndex` on the
session token; yt-dlp query passed as a single argv element with a kill-timer. `docker-compose.yml`
has `no-new-privileges`, `cap_drop: [ALL]`, non-root user, pinned base image.

---

## 7. Doc index

Three live docs, and open work lives in GitHub issues (not in a file):

| Doc | What it owns |
|---|---|
| [`ARCHITECTURE.md`](ARCHITECTURE.md) | **How the system works** + invariants |
| [`HANDOFF.md`](HANDOFF.md) | **How to run and operate safely** + traps + verification |
| [`DECISIONS.md`](DECISIONS.md) | **Ratified decisions**, the parked scope fence, lyrics-chain model |

Everything else is evidence: `mocks/` holds eyes-on frames, `benchmarks/` and `research/` hold
measurements and write-ups, and [`../README.md`](../README.md) is the user-facing quickstart.
