# 🎤 Encore — Roadmap (open work only)

Status: **LIVING** · this file holds **what is left to build**. Everything shipped has moved to
[`archive/`](archive/) — go there for *why it is built this way*, never for *what to do next*.

- [`archive/milestones-m0-m8.md`](archive/milestones-m0-m8.md) — M0–M8, all closed.
- [`archive/backlog-shipped.md`](archive/backlog-shipped.md) — every shipped backlog item, under its
  retired code. The 2026-09-05 section holds the five that were still carrying `[x]` in the open queue.

---

## START HERE — the auto-pilot contract

**What Encore is today.** A self-hosted karaoke server that works end to end: phone remote (QR join,
search, one-tap queue), TV/stage (gapless playback, room states, presence), a Demucs worker that
strips vocals on demand, and word-timed lyrics with provenance labelling. Songs
persist in a self-describing media volume, browsable by artist and genre.

**Run it.**
```bash
cd apps/core && bun run build
PATH="/home/angryang/.local/share/mise/installs/python/3.12.13/bin:/home/angryang/ffmpeg:$PATH" \
  HOST=127.0.0.1 PORT=5180 bun run server.ts
```
`yt-dlp` is invoked **by name via PATH**, so that directory must be on PATH or YouTube search
silently returns empty. The worker is a separate process — `docker compose --profile stems up`, or the
long-lived `encore-worker-live` container.

**Verification gates — run all four on every item.**
```bash
bun test                              # 1307 (core + shared) — runs from the REPO ROOT
cd apps/worker && python3 -m pytest   # 542 passed, 1 skipped
bun run typecheck && bun run build    # both workspaces
```
`runMigrations()` locates `apps/core/drizzle` by walking up from `import.meta.dir`, so `bun test`
works from anywhere. If you see a doc claiming it must run from `apps/core`, that note is stale.

**A green suite is the floor, not the bar.** Every real defect in this project so far was invisible
to a passing suite and only surfaced by driving the app. Anything with a rendered surface needs
eyes-on; screenshots live in `docs/mocks/` as `<id>-<what>-eyeson.png`.

**Environment ceilings — flag these, do not fight them.**
- `lrclib.net` fails DNS outright (`gaierror`) **on this laptop only**; `huggingface.co` and
  `www.youtube.com` resolve from the same shell. So it is a box property, not a project fact — hence
  `ENCORE_LRCLIB_BASE`. WhisperX models **do** download, so real-ML lyrics work is verifiable here.
- Demucs/WhisperX run in the worker container, ~1–2 min/song on CPU.
- Host ffmpeg (`/home/angryang/ffmpeg/ffmpeg`) is a **stripped 7.1.1 build**: no AAC encoder, no mp4
  muxer, no `ffprobe`. Use the **container's** ffmpeg (`docker exec`) for probing and transcoding.
- A long-lived Python process does **not** reload bind-mounted source; `docker restart` after editing
  worker code.
- YouTube autoplay-with-audio needs a user gesture in-browser.

**Working order and task IDs** live in [Open tasks](#open-tasks) — one copy, not two. Read the
numbering rule there before writing any commit message or comment that mentions a task.

---

## Adopted: reuse from the nomadkaraoke tools (decided 2026-09-03)

Four upstream projects were surveyed. **All four are MIT licensed**, so direct dependency,
vendoring, and copying with attribution are all open to us — no licence blocker anywhere.

| Project | Verdict | Why |
|---|---|---|
| [`python-audio-separator`](https://github.com/nomadkaraoke/python-audio-separator) | **Adopt as a dependency** | The separation engine under `karaoke-gen`, on PyPI. Wraps the UVR model family (MDX-Net, VR Arch, Demucs, MDXC/RoFormer). → `T-11` |
| [`karaoke-lyrics-processor`](https://github.com/nomadkaraoke/karaoke-lyrics-processor) | **Adopt for half the job** | Length-bounds and cleans lyric lines. We keep its bounding/parens/punctuation and supply the boundary split it gets wrong. → shipped |
| [`flacfetch`](https://github.com/nomadkaraoke/flacfetch) | **Borrow one idea** | Its provider+ranking pattern already landed independently as `lyrics_chain.acquire()` + `pickBestLyrics`. Its stream-quality heuristic has not. → shipped |
| [`karaoke-gen`](https://github.com/nomadkaraoke/karaoke-gen) | **Ideas only, no dependency** | Mostly scope we do not want (4K render, CDG packaging, YouTube/Dropbox upload). Its **human review stage** is the keeper. → **Deferred** |

**Why the separator swap is the highest-value change.** Two independent wins from one dependency:
1. **Instrumental quality.** The owner reports crash-cymbal artifacts on a 5.1.2 system. That damage
   is done by `htdemucs`' vocal mask, and **no codec change reaches it** — FLAC cannot recover what
   separation discarded. A better model is the only lever that does.
2. **Lyrics quality, for free.** The ASR tier transcribes the **vocals stem**. Cleaner separation →
   better transcribed text → a better `agreement_score` signal → better `pickBestLyrics` ranking. The
   swap improves the lyrics chain without touching it.

It also ships platform acceleration we would otherwise have to write: CUDA, Apple Silicon MPS/CoreML
with per-model-type device mapping, DirectML, and an automatic CPU fallback for long inputs.

**Why `karaoke-lyrics-processor` is only half adopted.** It is a length-BOUNDER, not a
phrase-finder: `find_best_split_point` bisects an over-long span, preferring a comma near the MIDPOINT,
then `" and "`, then the middle word. **MEASURED 2026-09-03** on a synthetic one-line blob at
`max_line_length=36`, that glues the next line's leading conjunction onto the previous line's tail
(`"until the morning came around, and"`) in 3 of 9 lines, and it never breaks on a sentence boundary at
all (`"never made a sound. So tell me"`). Where a span has no comma near its midpoint it degrades to
plain word-boundary bisection — no better than the char-count fallback the TV overlay already had.

So we find the phrase boundaries and hand it **lines instead of a blob**; it only ever splits, never
joins, so it then intervenes solely on pieces still too long. It keeps the parts worth having:
bounded-iteration length capping, stack-matched nested-parenthesis isolation, punctuation and
Unicode-space cleanup.

**Validated against this repo's own artifacts, not just synthetic text** — and the first cut was wrong.
Of the 171 over-long lines in `media/derived/lyrics/*-asr*.json`, a first version splitting only on
sentence ends and `", <conjunction>"` left **91% untouched**. Whisper is *not* unpunctuated (83% of
those lines carry `.,!?`) but its full stop lands at the END of a segment with nothing after it to split
off. Adding a greedy re-pack at **bare commas** (whisper puts them at breath boundaries) and a
**capitalised line-opener** rule (it marks phrase starts with case even when it omits punctuation) took
the share fully resolved with no bisection from **3% → 47%**, and improved **8% → 71%**. Openers are a
CLOSED set of function words and imperatives, because "any capital" breaks `"the rains down in | Africa"`
and `"my fancy house in | London town"`. The remainder is genuinely structureless: vocalisations
("Na na na …", 182 chars) and whisper's repetition failure mode (one 636-char line repeating a phrase
eleven times), where bisection is the only honest answer and is adequate.

Gated on `is_authoritative_text`, so **only auto-transcribed text is touched** — every authoritative
tier already arrives line-broken by a human (`parse_lrc` yields one entry per stamp;
`plain_lyrics_to_segments` keeps the lyrics site's own lines), and a splitter can only damage those.

**Installed `--no-deps`.** MEASURED: a plain install resolves to **30 packages, 29 unused** — its
declared `textract-py3` drags SpeechRecognition, pdfminer.six, python-pptx, oletools + pcodedmp (a VBA
macro deobfuscator), cryptography, easygui (Tkinter), xlrd<2; `python-docx` is declared but never
imported in upstream's source and solely drags lxml. All of it serves `.doc`/`.rtf` ingestion and a
clipboard copy — features we never call, since our text arrives in memory. pip *did* resolve the full
tree cleanly against the torch/whisperx set, so this is unused weight, not a version conflict.

**Known cost, recorded honestly.** `T-11` likely **supersedes `a76ab4a`** (the adaptive `-j` default,
measured 1.72× on 32 cores). Those numbers are `htdemucs`-specific and stop applying if the engine
changes. Re-benchmark rather than assuming they carry over.

**Not adopted.** `flacfetch`'s lossless sources (RED/OPS private trackers, Spotify via `librespot`)
would attack the real source-audio ceiling — YouTube gives us ~130–150 kbps lossy and everything
downstream inherits it. Parked deliberately: it needs a Transmission daemon plus tracker credentials,
and the sourcing question is the **owner's call, not the loop's**. Do not pick this up.

---

## Ratified: metadata, acquisition, and processed-only playback (decided 2026-09-03)

**Shipped and verified.** The working spec (`docs/SPEC-musicbrainz-fetcher.md`) was ephemeral and has
been deleted; the durable explanation lives in [`ARCHITECTURE.md`](ARCHITECTURE.md) §6–§7. The decisions,
so they are not re-litigated:

| # | Decision | Ratified |
|---|---|---|
| — | **MusicBrainz is an annotator, not a catalog.** Search stays yt-dlp; identification runs after the download and only enriches a media that already exists. | yes |
| — | **Nothing plays unprocessed.** No embed path, no raw-source path, no per-source exception for local files. `playMode` is gone. | yes |
| — | **One row per song is NOT a requirement.** With best-effort identification, grouping two uploads is probabilistic, and merging on a weak signal collapses two different songs. No Song table, no `songKey`. | yes |
| D4 | **Refuse rather than guess.** A weak match keeps the normalizer's values and records nothing. | yes |
| D7 | Columns-only migration; no sidecar re-shape (`playMode` was derived on read, never stored). | yes |
| D9 | Confidence from duration: ±2s → `high`, ±5s → `medium`, else nothing. ±2s because that is LRCLIB's own matching tolerance. | yes |

**Withdrawn, with the cost named.** The Song/Version split, the versions popup, a per-song default
rendition, and lyrics text shared across renditions were all specced and then cut. The one that actually
costs something: **source-fidelity upgrades are no longer expressible.** A better source is a different
`sourceRef` and therefore a different row, with no link to the old one, so "re-acquire from a better
source, then re-cook" cannot be modelled. `sourceFidelity` is still worth recording as provenance, but
it is not a rung of the upgrade ladder.

**Album and year are deliberately not taken from MusicBrainz.** Measured live they resolved "Take On Me"
to a 1991 hits compilation and "Bohemian Rhapsody" to an undated bootleg — a search hit's release list is
partial and the recording is chosen by duration, so a live cut that matches the file's length brings its
own release with it. A trustworthy album needs a second release-group lookup; until then D4 applies.

**Known gap, not a bug to rediscover.** Media materialised *before* canonicals were parsed at
materialize time never got them, and search reuses an existing row rather than re-materialising it — so
those songs are never annotated without a backfill pass. Nothing surfaces this; it just looks like
annotation ignoring old songs.

**What the verification pass was worth.** Driving the real server found four bugs no test had caught,
which is the argument for the "green suite is the floor, not the bar" rule in
[`HANDOFF.md`](HANDOFF.md) §8:

- A `fetch` completion marked the media `ready` with a derived instrumental key for a file that did not
  exist. Invisible because `stems` follows within seconds and overwrote it.
- `mbid`/`annotation` were runtime-only, so a restart forgot that an artist had been *cited* — defeating
  the never-regress rule one commit after it was added.
- The TV's join QR encoded **https** on a plain-HTTP LAN, because adapter-node reports https whenever
  `PROTOCOL_HEADER` is unset. Unopenable by any phone; hidden by always testing through an https tunnel.
- Two ways one malformed WebSocket frame killed the whole process — an unvalidated command envelope, and
  a telemetry frame that poisoned playback state into something unpersistable (`Math.floor(undefined)`
  is NaN, which SQLite stores as NULL against a NOT NULL column) and then threw out of the write-behind
  flush timer, detached from the frame that caused it.

---

## Open tasks

Task IDs are `T-<n>`, assigned once and never reused. **The hyphen is load-bearing:** bare `T1`
already occurs 320 times in this codebase as timestamp constants (`T0`, `T1` in
`play-log.test.ts`), so a bare-number scheme cannot be guarded. `T-<n>` and `ENC-<n>` both occur
zero times.

> **A task ID may appear in a PR title, a PR body, a commit message, and files under `docs/`.
> Nowhere else — not in source, not in comments, not in tests, not in fixture data.** A task number
> is scheduling metadata with a lifetime of days; code outlives it and a stale reference sends the
> next reader to a roadmap line that no longer exists. When code needs to explain *why*, it states
> the reason or points at a durable doc section — never at a task number. `T-1` adds the guard that
> makes this mechanical.

**Working order.** `T-1` → `T-2` → `T-3` → `T-8` (design only) → `T-4` → `T-5` → `T-6` → `T-7` →
`T-9` → `T-10` → `T-11` → `T-12` → `T-13`. `T-14` whenever the owner is at the deploy box.

Two ordering constraints that are not preference:

- **`T-4` before `T-5`/`T-6`/`T-7`.** The rename touches ~1440 sites; every task that lands first
  adds more sites to rename.
- **`T-8`'s ruling before `T-7` starts.** Whether a media has versions decides what the library and
  now-playing surfaces are *shaped* like, and that is the rewrite's core question, not a detail.

---

- [ ] **T-1 · Task-number hygiene, and the guard that keeps it** — five stale references exist
  today, all comments: `apps/core/src/server/jobs/vocabulary-parity.test.ts:268` (`roadmap B-8`),
  `apps/core/src/lib/components/SongRow.svelte:13` (`shipped in M6-C1`),
  `apps/core/src/lib/stores/queue.ts:8` (`(M3)`), `apps/core/server.ts:61` (`/api/search (M4)`),
  `apps/worker/src/separation/roformer.py:43` (`docs/ROADMAP.md (B-8)`). Rewrite each to say the
  thing instead of citing the ticket — the `roformer.py` one should name the decision, not its
  roadmap coordinates. Then add a guard that scans source, comments and tests for `\bT-[0-9]+\b`
  and the retired `\bB-[0-9]+\b` / `\bM[0-9]-C[0-9]+\b` families, and fails with the offending
  `path:line`. **AUTO** — the guard must be proven by planting a reference and watching it fail.

- [ ] **T-2 · Retention for the two append-only tables** — `job_attempts` and `plays` grow without
  bound. Nothing prunes them and nothing should until there is a policy: attempt history is the only
  record of how a song was made, so eviction is a real loss rather than a cache miss. Mirror
  `ENCORE_MEDIA_MAX_GB`'s shape — a soft cap, oldest-first, unset = never delete. Not urgent (a row
  is tens of bytes) but it should not be discovered later as a surprise. Deletes rows, so no
  migration. **AUTO** — unit.

- [ ] **T-3 · Hot-titles persistence** — the popularity tracker is in-memory: it survives a refresh,
  not a restart. Persist counts so "🔥 Popular tonight" survives a restart. Decide first *where* the
  counts live — `plays` can already answer "how often" by aggregation, which may make a new column
  unnecessary; a new table or column is a migration and needs saying out loud. **AUTO** — unit.

- [ ] **T-4 · Comprehensive `cook` → `process` / `processing` rename** — reverses an earlier
  decision that renamed only UI copy and deliberately left `cook` in code (`cookId` included). The
  measured surface: **~1440 occurrences** — `apps/core/src/server` 675, `apps/core/src/routes` 250,
  `apps/core/src/lib` 231, `packages/shared/src` 150, `apps/worker/src` 88,
  `apps/worker/tests` 46 — plus **two DB columns** (`job_attempts.cook_id`, `plays.cook_id` and the
  `job_attempts_cook_idx` index), the `cookId` wire field (51 uses), and the TS↔Python vocabulary
  parity guard.

  Three things make this a different shape of task from everything else here:
  - **It must run solo.** A diff across ~1440 sites conflicts with every open branch and all ~36
    live worktrees. Drain them first, or accept a mass rebase.
  - **It crosses the wire and the schema at once.** `packages/shared` is the contract, so the TS and
    Python sides must move in the same commit, and the column rename is a migration. Sidecars on
    disk were checked and carry **no** `cookId`, so the media volume needs no rewrite — that is the
    one piece of luck here.
  - **`process` is an overloaded word.** The worker literally has OS processes, and
    `apps/worker/src` already talks about them. Pick the noun deliberately (`processing` for the
    activity, `run`/`attempt` for the instance) rather than a blind
    `s/cook/process/`, or the code gets *less* readable. This is a naming decision to make before
    the first edit, not during. **AUTO** — the parity guard plus a full suite; the risk is
    silent partial rename, so the guard must reject a vocabulary that exists on one side only.

- [ ] **T-5 · Finish the room work** — the storage layer is already multi-room and the runtime is
  not. `rooms` (`id`, `code`, `created_at`) and `room_settings` exist, and the settings repository
  is genuinely keyed per room (`getRoom('room-c')` resolves today). But `roomId` is threaded through
  only **14 places**, and the four tables that carry a party's actual state —
  `queue_entries`, `singers`, `playback_state`, `plays` — have **no `room_id` column at all**. So
  "finish" means: thread the room key through those four, scope the WebSocket topics so two rooms
  cannot see each other's queue, make join-by-code resolve a room, and decide what a singer who is
  present in one room *is* in another. Carries the room-scoped **away/skip** interaction that the
  queue-order work deliberately left open: `least-recently-sung` orders by when someone last sang,
  and "present but away" is a different concept the presence lifecycle owns.
  *Done-when:* two independent rooms run on one core without leaking state.
  **AUTO** — rotation and scoping are unit-testable; **EYES-ON** — two phones in two rooms.

- [ ] **T-6 · Duet management** — greenfield: `duet`, `coSinger` and `secondSinger` appear **nowhere**
  in the repo. `queue_entries.singer_id` is a single non-null column and `singers` has no pairing, so
  the modelling decision comes first and everything else follows from it: a second nullable
  `singer_id`, a join table, or a "party" concept that a solo turn is just the degenerate case of.
  The rotation is the hard part, not the schema — a duet consumes whose turn? Fair rotation currently
  gives everyone their 1st pick before anyone's 2nd, and a two-singer entry either burns both slots
  or burns one and lets a pair jump the queue. Decide that *before* the column. Also touches
  `Singer.lastSungAt` (do both get stamped?) and the TV lower-third, which names one singer today.
  **Serialize with `T-5`** — both migrate `queue_entries`.

- [ ] **T-7 · Client-side UI rewrite** — design work plus general polish, across the phone remote and
  the TV. Blocked on `T-8`'s ruling, because whether a media has selectable versions changes what a
  library row and the now-playing sheet *are*, not just how they look. Constraints already
  established and not up for re-litigation: every stage-look option stays pinned dark so lyrics
  remain readable; there are no spectrum bars because the TV does not listen to the audio; icons are
  vendored Lucide *path geometry* with no webfont and no emoji (a stripped smart-TV font drops both,
  which is why accidentals are ASCII `G#`/`Ab`); touch targets are ≥44px. Frames land in
  `docs/mocks/` as `<id>-<what>-eyeson.png`. **EYES-ON** — every surface, at 390/820/1440px and at
  TV width; a green suite has never once caught a UI defect in this project.

- [ ] **T-8 · Expose multiple versions of a media** — *design task; ruling needed before `T-7`.* This
  splits into two halves that look alike and are not.

  **The lyrics half is already modelled and merely hidden.** `Media.lyricsCandidates` holds *every*
  lyrics artifact, one per text source, and `lyricsRef` points at whichever `pickBestLyrics` chose;
  the rest are retained precisely so a better source can be re-aligned later and so a coarser late
  arrival can never displace word timings. Provenance is read from the chosen candidate via
  `chosenCandidate(media)`. So "expose multiple lyrics versions" needs **no schema work** — it needs
  a selector surface, a way to override the automatic pick, and a decision about whether an override
  is per-song, per-room, or sticky. That is buildable now.

  **The quality/fidelity half re-opens a ratified withdrawal.** The Song/Version split was specced
  and then deliberately cut, and the roadmap already records what that cost: *"source-fidelity
  upgrades are no longer expressible. A better source is a different `sourceRef` and therefore a
  different row, with no link to the old one, so 'reacquire from a better source, then re-cook'
  cannot be modelled."* Reversing it means reversing the reasoning that killed it — grouping two
  uploads is probabilistic, and merging on a weak signal collapses two different songs. `D4`
  (refuse rather than guess) is the rule that would have to bend.
  **Owner's ruling required:** ship the lyrics selector alone, or re-open the Song/Version split
  with a hard non-probabilistic link (an explicit user action, not a matcher).

- [ ] **T-9 · Re-align on better text** — the backfill covers "no lyrics yet"; this covers "LRCLIB
  became reachable, or the text was corrected". *Done-when:* a song whose text improves gets
  re-aligned **from retained audio** (no re-download, no re-separation) and can never regress from
  word- to line-level timings. **AUTO** for the upgrade-not-regress invariant and the trigger, but
  **NET-blocked on this box** — `lrclib.net` fails DNS here, so the end-to-end trigger cannot be
  exercised locally. Implement, unit-cover, and flag.

- [ ] **T-10 · Gate `/metrics` and the audit log** — *product decision, not a patch.* Both surfaces
  shipped ungated by decision: Encore has no operator identity, and the only auth axis is anonymous
  vs any-singer, which any LAN phone obtains by POSTing `/api/join` — a singer check would have been
  theatre. Exposed today: worker ids, resolved model/backend/device names, host details, terminal
  error strings. No singer identities, no media bytes. Three options, ascending:
  `ENCORE_ADMIN_TOKEN` compared on the two endpoints; bind those routes to a trusted interface; or a
  real **host/operator concept**. Only the third also closes the standing hole that lets any joined
  phone `PUT /api/settings` — including `asrModel` and `syncMode`, i.e. which Whisper weights the
  fleet loads. **AUTO** — the gate rejects an unauthenticated read; **EYES-ON** — settings still work.

- [ ] **T-11 · Swap the separator to `python-audio-separator`** — the fit is clean because
  `demucs.py` is pure argv-plus-subprocess with zero numeric imports: the dial-home loop, job ledger
  and progress reporting do not move. Two wins from one dependency: instrumental quality (the
  crash-cymbal artifacts are done by `htdemucs`' vocal mask, and no codec change reaches them), and
  better lyrics for free (the ASR tier transcribes the vocals stem, so cleaner separation feeds a
  better `agreement_score`). It also ships CUDA / MPS+CoreML / DirectML device mapping and a CPU
  fallback for long inputs. Known cost, recorded honestly: it likely supersedes the adaptive `-j`
  default whose 1.72×-on-32-cores measurement is `htdemucs`-specific — re-benchmark rather than
  assume. *Done-when:* **the owner has ranked the candidate models by ear.**
  **EYES-ON/AUDIO** — a test cannot hear vocal bleed. **AUTO** for argv/params construction, model
  selection, progress parsing, and the missing-model error.

- [ ] **T-12 · Accounts** — an ephemeral singer can "claim" an account (OAuth or local).
  *Done-when:* claiming works and **nothing about the join flow regresses**. Also unblocks
  per-singer vocal-range calibration, which is currently impossible for a concrete reason: the mic
  half exists (`detectF0`, `MicPitch`) but `singers` has nowhere to store a range, which is why the
  range is drawn against named voice bands rather than against you.

- [ ] **T-13 · History and favorites** — *Done-when:* re-queue a saved karaoke instantly, skipping
  the worker. Largely covered by the saved library already; what is left is per-account history and
  favorites. Note the deliberate constraint it runs into: the play stamp records *that* someone sang
  and *when*, never *what* — no `singer_id` in `plays`, on purpose. Any policy wanting "who has sung
  this song" needs that decision revisited first, not worked around.

- [ ] **T-14 · Verify the pitch shift audibly** — the numeric half is done and fixed (`c2c0e7b`,
  "make the pitch shifter actually work at every shift"). What remains has never been heard: whether
  ±1 semitone *sounds* right, whether the OLA quality holds, the suspended-`AudioContext` fallback,
  and the graph lifecycle. Only the ratio/framing/window maths is tested. Needs the RTX 3080 deploy
  box and a human in the room. **AUDIO.** Tag **v1.0.0** work behind this, not this behind it.

- [ ] **T-15 · The processing progress bar completes before the song is playable** — the bar fills
  solid and the readout says `100%` while three of the five milestones have not started. Observed on
  the phone remote with the chip strip reading `✓ Queued · • Fetched · Making karaoke · Adding
  lyrics · Ready` underneath a full bar.

  **Root cause: `pct` is the current STEP's own 0–100, not overall cook completion.**
  `apps/core/src/server/jobs/worker-hub.ts:182` writes the worker's per-step `job:progress.pct`
  straight into `jobs.progressPct`, and `apps/core/src/lib/components/ProcessingCard.svelte:78`
  scales the entire bar by it (`transform:scaleX({pct / 100})`) with the same number printed at
  `:79`. So *every* step reaching 100% fills the bar.

  Two things this is **not**, both worth stating so they are not re-investigated:
  - **Not a label bug.** `cookStageLabel` deliberately returns one guest-facing phrase
    ("Making karaoke…") for every in-flight status, so the line agreeing with none of the chips is
    by design — the percentage and ETA are the caller's job and the helper owns only the words.
  - **Not the strip bug already fixed.** `69bc5dc` made the *chips* monotonic and moved their order
    onto the shared list; it never touched the bar's scale.

  **The primitive already exists.** That same fix added `MEDIA_STAGES` and `mediaStagePosition` to
  `packages/shared`, so overall progress can be a band per stage with the intra-step pct scaled
  inside its band — no second hand-written order list, which is what drifted last time. Choose the
  bands deliberately: separation dominates wall-clock at ~1–2 min/song on CPU, so equal fifths would
  make the bar lie in the other direction.

  *Done-when:* **the bar and the readout reach 100% if and only if `status === 'ready'`**, and never
  move backwards across a stage change. `repository.ts:172` already sets `progressPct: 100` on the
  transition to `ready`, so that invariant is expressible exactly rather than approximated.
  **AUTO** — the iff and the monotonicity are unit-testable from a stage sequence; **EYES-ON** — the
  bar mid-cook on the phone.

- [ ] **T-16 · Loudness normalization, so the room stops reaching for the volume knob** — songs
  arrive from YouTube mastered at wildly different levels, and the instrumental is quieter again than
  the mix it came from because separation removes energy. Two terms, and the second is probably the
  one being felt: a per-song spread *and* a systematic instrumental-vs-original offset.

  **The shape that fits this codebase: measure at cook time, apply at playback.** The ReplayGain
  model — non-destructive, retroactive over the existing library through a backfill (the lyrics and
  guiding-track backfills are the precedent), and re-tunable later without re-encoding anything. This
  is the same argument that settled the pitch shift in favour of the browser: no per-variant files, and
  every already-cooked song benefits.

  Four things that are decided by what is already here, not by preference:

  - **Measure integrated loudness, not peak.** `apps/core/src/server/media/loudness.ts` and the
    worker's `volumedetect_argv` already shell to ffmpeg and parse a level, but they report mean/max
    **dBFS** for the digital-silence check (`SILENCE_FLOOR_DB`, and `app.ts:261` uses it to avoid
    advertising a silent guiding track). Peak is not perceived loudness — normalising by it gets a
    dense master and a sparse one wrong in opposite directions. What is needed is EBU R128 integrated
    LUFS plus true peak: `-af loudnorm=print_format=json` reports `input_i` and `input_tp`. Reuse the
    parse-a-number-from-stderr shape, not the number itself.
  - **Measure inside the `stems` step, where the decoded WAVs already sit in scratch.** Exactly the
    argument that got key and vocal range in for no extra decode and no new job type — and that step
    already probes the stems for silence, so it is the same pass.
  - **Store it in `songProfile`.** It is already the nullable JSON record of what the cook *learned*
    about the music, it already holds individually-nullable fields, and its gate keys on the record
    being present rather than populated — so a track whose loudness could not be measured completes
    like any other. No new column, no migration.
  - **Apply it with `HTMLMediaElement.volume`, not a `GainNode`.** This is the point worth
    understanding before any code: `.volume` is plain linear attenuation and needs **no
    `AudioContext`**, so it side-steps the whole suspended-context problem `T-14` documents — a
    set-and-forget TV may never receive the user gesture an `AudioContext` needs to `resume()`. The
    cost is that `.volume` is capped at `1.0`, so it can only turn things **down**: the target has to
    sit at or below the quietest track worth playing, or quiet songs stay quiet. Boosting means a
    `GainNode` and taking the context bet, which is a separate decision.

  **The trap:** the guiding track is a *second* media element mixed under the instrumental, so the
  per-song gain must apply to both while preserving the guide ratio. Scale only the instrumental and
  turning the guide on changes the perceived level of the whole song.

  *Done-when:* two songs known to differ by a wide margin play at a matched perceived level with no
  manual change, the guide ratio is unchanged by normalization, and an unmeasured song plays at
  today's level rather than silent. **AUTO** — the gain computation, the clamp, and the
  both-elements invariant are pure and unit-testable; **AUDIO** — that it actually sounds level needs
  the owner and real speakers.

- [ ] **T-17 · The ± semitone buttons do not change the pitch** — *investigation, and the one to be
  most careful with.* Reported after PRs #40/#44, both of which touched the very element the shift
  graph attaches to, so suspecting them is reasonable — but the wiring reads intact end to end: the
  phone stores `PlaybackState.keyShift`, `routes/tv/+page.svelte:277` assigns it from
  `playback:state`, and `TvPlayer.svelte`'s effect (~`:328`) builds a `PitchShiftGraph` lazily on the
  first non-zero shift and calls `setShift` on every change. The `<video>`→`<audio>` rename carried
  through by binding.

  **Ruled out already:** a missing worklet asset. `pitch-shift.ts:445` builds the worklet from an
  inline source string via a Blob URL rather than a separate build chunk, so there is no
  404-on-a-chunk failure mode. (A CSP forbidding `blob:` would still break it; this app sets none.)

  **Ranked hypotheses, most likely first:**
  1. **The `AudioContext` never resumes, and this is the documented degradation rather than a
     regression.** `pitch-shift.ts` states the contract: a context that cannot run leaves the audio
     **audible-but-unshifted, never silent**. And the Deferred section already records that **`/tv`
     has no gesture handler** — a set-and-forget TV may never receive the user gesture `resume()`
     requires. That produces precisely the reported symptom: sound plays, buttons do nothing.
  2. `active` is false for the audible slot, so `const shift = active ? keyShift : 0` pins it to 0.
  3. The graph builds but `setShift` is not reaching the worklet's ratio.

  **Run the diagnostic before changing any code:** on the TV, check whether an `AudioContext` exists
  and what its `state` is. `suspended` confirms (1), and then the fix is a gesture affordance on
  `/tv`, *not* a change to the shifter — which also unblocks the deferred FFT visualizer work, which
  needs the same context.

  **The invariant any fix must not break** (this is the regression risk worth being careful about):
  at `keyShift === 0` there is **no `AudioContext` and no `MediaElementSource`**, so the audio path is
  byte-for-byte what it always was. A `MediaElementSource` is a **permanent** capture of the element
  once created — so a fix that eagerly wraps the element commits all room audio to WebAudio forever.
  A broken shift is bad; silent room audio is catastrophic. **AUDIO/EYES-ON.**

- [ ] **T-18 · Word-by-word highlight does nothing on some songs** — *root-caused.* Distinct from
  `400cd44`, which fixed the amber provenance tint erasing the highlight — same symptom, different
  cause, which is why it "still isn't working despite other fixes".

  **`resolveLyricsPresentation` clamps on fleet CONFIG, not on the playing song's DATA.**
  `packages/shared/src/settings.ts:603` computes
  `wordsAvailable = getSyncMode(settings.global.syncMode)?.granularity === 'word'` — a global value.
  Its comment is correct in one direction (under `syncMode: 'lines'` there are no per-word stamps)
  and the code assumes the converse, which does not hold: under a word-level `syncMode` — `forced`,
  the default — an individual song can still be **line-only**, because its chosen lyrics candidate
  came from a line-level source. LRCLIB records carry per-line stamps, not per-word.

  So `wordsAvailable` is true, no clamp fires, and the overlay is told to draw word-level highlighting
  against segments that have no `words` to light — rendering the current line uniformly in one colour.
  That matches the report exactly: current line fully white, no distinct current word, with Settings
  still showing "Word by word" as if it were in effect.

  **Fix direction:** keep the global clamp as the OUTER bound (the fleet cannot produce what it cannot
  produce) and add a per-song INNER bound from the chosen candidate's granularity — `chosenCandidate(media)`
  already resolves it, and provenance is already read from there. *Diagnostic:* check whether the
  playing song's lyrics JSON segments carry a `words` array; this could not be run on the loop box,
  which has no `media/`. **AUTO** — the resolver is pure, so per-song clamping is directly
  unit-testable including the case that fails today; **EYES-ON** on the TV.

- [ ] **T-19 · Restarting a song desyncs the guiding track from the instrumental** — *root-caused.*
  The seek path repositions **only the master**: `TvPlayer.svelte:306` is
  `if (active && Math.abs(master.currentTime - seekSec) > 1.5) master.currentTime = seekSec;` with no
  companion assignment for `vocals`. So a back-button restart moves the instrumental to 0 and leaves
  the guide wherever it was.

  Recovery is then left to the drift governor (`guideCorrection`, ~`:402`), which by deliberate design
  prefers a `playbackRate` trim over a reseek — the comment at `:74` says assigning
  `vocals.currentTime` "is the wrong tool at this scale". That is right for continuous drift of a few
  tens of milliseconds and wrong for a discontinuity, so the guide either crawls back over many
  seconds or, if the residual sits under the reseek threshold, never hard-resyncs at all. Hence
  "slightly desync'd" rather than wildly.

  Note the play path at `:278` already does the right thing — it hard-aligns `vocals.currentTime` to
  `master.currentTime` when they differ by more than `GUIDE_PREROLL_ALIGN_SEC` (0.04s). The seek path
  simply has no equivalent. Also worth checking: that `> 1.5` guard means a restart from a position
  already under 1.5s may not move the master at all.

  *Done-when:* a restart leaves both elements within the preroll tolerance immediately, not
  eventually. **AUTO** — the decision "a seek must realign the guide" is pure and testable against
  two fake elements; **AUDIO** — that no flam is audible needs the owner.

- [ ] **T-20 · TV lyrics jump to the top when the tab is defocused while paused** — *investigation.*
  Defocus the TV while paused and the text scrolls back to the first line; unpausing resumes at the
  correct place. So the *rendered* scroll offset is not a pure function of `currentTime` — it is
  loop-carried state in an animation frame callback, and a backgrounded tab has its `rAF` throttled
  or stopped, which drops whatever was accumulating the offset back to its initial value.

  **Fix direction is the shape, not the symptom:** make the drawn offset a pure function of
  `currentTime` plus the presentation settings, so a stopped `rAF` has no state to lose and
  `visibilitychange` needs no special case. Re-deriving on visibility change alone would paper over
  it while leaving the accumulator in place.

  Lowest severity of this group — it is cosmetic and self-corrects on unpause — but it is visible to
  the whole room during a pause, which is exactly when people are looking at the screen. **AUTO** —
  the purity property is testable without a browser; **EYES-ON** to confirm the pause/defocus cycle.

- [x] **T-21 · Repair the e2e harness — it is the loop's only pair of eyes, and it is blind** —
  **done.** `bun run e2e/party.mjs` now completes 10/10 against a seeded ephemeral server.

  Two claims in the original entry were wrong, and the corrections are the interesting part:

  **`.url` had not been deleted — it was on the wrong screen.** It is the LOBBY's typed join address
  (`TvLobby.svelte`), so it renders only once somebody HAS joined. The gate was therefore *inverted*:
  it could never pass on the fresh empty room it demanded, which is why it printed "restart the
  server" at a server that was already empty. The attract screen's own address is `.idle-url`.

  **There were eight unguarded literals, not four.** The original table missed `.hint` (a class the TV
  renders nowhere — the ten-foot assertion measured nothing and defaulted to 0px), `.brand`, `.peek`,
  and `#tab-${id}`; and once the guard was broadened past "must start with `.` or `#`" it found five
  more (`video, audio` ×2 — which had already rotted once from a bare `video` — plus `h1` ×2 and
  `body`). The guard now works by CALL SITE (any selector-taking function invoked with a string
  literal) rather than by guessing selector syntax, because every syntactic guess was a hole.

  A third defect had no entry at all: the flow trusted the FIRST render for "is the room empty", but
  `online`/`away` are filled only by the socket's `queue:sync`, so the server ships the attract screen
  for every room — `/tv` on a server holding a leftover guest returns `attract`, `idle-url` and
  "Nobody here yet". The gate now waits for the socket, lets the sync land, and re-checks the screen at
  the moment of measurement so a late flip is reported as the environment problem it is.

  Also resolved: `e2e/seed-media.mjs` is **correct**, and the suspicion against it was a misdiagnosis.
  `/api/library` lists only songs whose stems are on disk (`app.media.listReady()`), and the four
  placeholders have none — so an empty `/api/library` is right. The flow searches, and
  `/api/search?q=…` returns the seeded tracks.

- [x] **T-22 · Rebase the lyrics text-size scale, and let it go much further** — SHIPPED (PR #250, issue #58). today's **80%** became the new **100%**, and the range now reaches much further.

  **Owner ruling (blessed the product fork):** leave the stored values, widen the band, fold the neutral point. The render multiplier is `(scalePct / 100) * LYRICS_SCALE_BASE` with `LYRICS_SCALE_BASE = 0.8`, so a stored `100` renders `0.8×` (what `80` rendered before) while the number shown stays `100`. `DEFAULT = 100` (no migration), `MIN = 100` (the `0.8×` legibility floor is the neutral point), `MAX = 300` (`2.4×`). **Accepted one-time semantic shift:** every existing room's lyrics render ~20% smaller on deploy.

  **Clamp-up for the next author:** rooms that stored `80`–`99` under the old `MIN = 80` now clamp **up** to `100` when next normalized (`normalizeRoomSettings` → `clampInt`, `settings.ts:485`; a raw DB read is not re-clamped). Legacy `80` → `100` renders `0.8×`, identical to before; `90`/`95` shrink slightly into the floor. Nothing renders below `0.8×` afterward. The scale-vs-rows concern needed no new clamp: the reel's existing `max-height` cap + edge-fade mask absorb an extreme setting.

- [ ] **T-23 · Run every text tier through the length bounder; keep the semantic splitter for ASR and
  captions only** — *the answer to "is candidate text going through `karaoke-lyrics-processor`?" is
  **no**, and that is the likeliest cause of the long lines on screen.*

  `apps/worker/src/lyrics/presplit.py:356` is:

  ```python
  t if is_authoritative_text(t.text_source, t.text_confidence)
    else split_blob_text(t, max_chars=max_chars, bounder=bounder)
  ```

  The upstream bounder is reachable **only** through the `else` branch, so an authoritative tier —
  LRCLIB `syncedLyrics` via `parse_lrc`, LRCLIB `plainLyrics` via `plain_lyrics_to_segments` — is
  passed through with **no length bounding at all**. The only thing then catching an over-long
  authoritative line is the display-time fallback `LINE_MAX_CHARS = 42`
  (`apps/core/src/lib/tv/lyrics.ts:104`) — a char-count split that `presplit.py`'s own header dismisses
  as "no better than the char-count fallback the TV overlay already had".

  **One gate is doing two jobs.** The header's stated reason — "running a splitter over human-authored
  text can only damage it" — is a correct argument about the **semantic repacker** (the comma repack and
  capitalised-opener rules, which *rewrite* line structure). It is not an argument about the **length
  bounder**, and the same header already says why: *"Upstream only ever splits, never joins, so feeding
  it pre-broken lines is safe: it intervenes only on the pieces still too long."* That property holds
  just as well for a human-authored line that happens to be too long.

  So split the one gate into two:
  - **length bounding → every tier**, authoritative included;
  - **semantic re-lineation → ASR and auto-captions only**, which is exactly what
    `is_authoritative_text` already selects (auto-generated caption tracks are demoted to `low`
    confidence precisely so they land on that side of the fence).

  **The one real risk, to decide before coding:** upstream's pass is not only length bounding — it also
  does stack-matched parenthesis isolation and punctuation / Unicode-space cleanup. On human-authored
  text that cleanup *edits text a human wrote*. Decide whether to take the whole upstream pass on
  authoritative tiers or to invoke only its length bounding.

  Also: `max_chars` must agree with the TV's row budget, and therefore with `T-22`, which changes how
  much text a row holds — **do `T-22` first**. Once every tier is bounded at cook time, the display
  fallback should become a genuine last resort rather than the primary bound for a whole tier.

  *Done-when:* no tier reaches the TV with a line over the budget; a line-level LRCLIB record carrying
  an over-long line is bounded at cook time; and a guard proves the semantic splitter does **not** run
  on authoritative text. **AUTO** — `presplit` is pure and there is already a measured corpus to check
  against (the 171 over-long lines in this repo's own ASR artifacts).
---

## Lyrics-chain design notes (the part still worth reading)

The chain is built; this is the model it settled on, because it is easy to get wrong when extending it.

**Text quality and timing fidelity are INDEPENDENT axes.**

| Source | Text | Timing it yields unaided |
|---|---|---|
| LRCLIB `syncedLyrics` (LRC) | authoritative | **line-level** — no ML, no audio at all |
| LRCLIB plain / YouTube captions | good | none — needs forced alignment |
| ASR on the vocals stem | **dubious** | line-level (segment bounds) |

**Corrected by measurement during C4:** ASR does **not** yield word-level timing. Whisper's
`transcribe()` returns segment bounds and **zero words**; word timings come only from the separate
`align()` pass. So **the aligner is the single source of word timings for every tier** — one timing
layer, N text sources. This makes the architecture simpler than the original framing, not harder.

Consequences that shape any change here:
- **Line-level sync is the floor, word-level the ideal.** Raw LRC clears the floor with zero ML and
  zero audio, so lyrics can be ready *before* the instrumental.
- **ASR always runs, not just as a fallback** — it is a validation signal. LRCLIB's real failure mode
  is a confident *wrong* match, and comparing ASR of what is actually sung against the looked-up text
  is what catches it. It also supplies the `language` that `align()` would otherwise guess as `'en'`.
- **Ranking puts authoritative-text-with-line-timings ABOVE ASR-text-with-word-timings.** Wrong words
  are a failure — you cannot sing them; correct words with coarse highlighting is the accepted
  minimum.
- **ASR is the worst tier for words while looking the most finished.** So provenance labelling matters
  *most* exactly where the output looks most polished.

---

## Deferred — do NOT pick these up

Parked deliberately. These return only if the owner says so.

- **Audio-REACTIVE visualizers** — the time-driven ones shipped; making them respond to the sound did
  not. What shipped: four renderers (plasma, starfield, ripples, phase curves) as pure functions of `t`,
  selectable per room. What is still parked, and why each was designed *around* rather than solved:
  - *Real FFT.* Still needs an `AudioContext` on the TV, which does not exist. The gesture problem is
    **less severe than previously recorded here**: `/tv` has no gesture handler, but `TvPlayer` also
    swallows its autoplay rejection, so the app *already* depends on the TV permitting unmuted autoplay
    — an `AudioContext` is the same bet, not a new one. The real work is the graph: one
    `MediaElementAudioSourceNode` per `<video>` (two slots, each recreated when its `{#if}` toggles),
    following whichever slot is audible across a gapless swap, and reaching `ctx.destination` or **the
    song goes silent**. See HANDOFF gotcha 18.
  - *`bars` and `scope`.* Deliberately absent from `TV_VISUALIZERS`, and a test pins the exclusion by
    id. They assert they are drawing the signal; nothing reads it. They arrive **with** real analysis or
    not at all — and that test is the thing to delete, on purpose, in the commit that adds it.
  - *Score-reactive modulation.* Has no data to react to at all: scoring was REMOVED outright — no
    `score` job type, no reference pitch track, no `score:update`. It returns only if the scoring
    redesign lands (see the scoring entry above).
  - *Visualizers on the no-lyrics screens* (lobby, `waiting`, interstitial), where eye candy is safest
    because nothing competes with it. The ratified band for backgrounds is playing-only; extending it is
    a separate decision, not a follow-up.
  One incidental note that is load-bearing for any FFT work: it is possible at all only because
  `TvPlayer.fileSrc` hardcodes `/media/${ref}` instead of `MediaStore.url(ref)`, so the media element is
  always same-origin. Switch the TV to presigned object-store URLs and every FFT visualizer silently
  goes flat with no error.
- **Milkdrop-class WebGL preset rendering.** A hand-rolled fragment shader if ever, not `butterchurn`:
  this project vendored Lucide *path geometry* rather than accept a webfont, to stay offline-LAN-safe,
  and a multi-MB preset-interpreting engine is the opposite of that.
- **Human lyrics review UI** (idea from `karaoke-gen`, which treats review as a first-class pipeline
  stage). Well-motivated: C6 shipped provenance *labelling*, and review is the next rung up, with
  `SOURCE_MANUAL` already reserved in `lyrics_chain.py` for it to populate. Needs a core endpoint +
  phone UI + storage, so it is a feature, not a commit.
- **Lossless source audio via trackers/Spotify** (`flacfetch`) — see above; the owner's call.
- **Scoring, redesigned from scratch** — the original implementation was REMOVED (see below). The
  research behind the redesign is written up in
  [`docs/research/scoring.md`](research/scoring.md): derive a per-word note grid from the vocals stem
  + align timings (the `KeyAndRange` step is the precedent — same domain, same plan, no extra
  separation), DTW-align the singer, score multi-axis with pitch as ~half, and let a room setting pick
  a TIER rather than on/off. Blocked on the capture problem: a phone mic in a loud room hears the
  backing track, and every credible system solves that with hardware, not software. Carries the
  **v0.3.0 (scoring)** tag if revived.
- **VBR or mono for the vocals stem** — it is CBR 192k today, so silence costs the same as singing.
- **Re-encoding `audio/`** — still ~494 MB of pre-policy WAV. It is the only **unrecoverable** class,
  so touching it is the owner's call.

---

## Conventions

- Each checklist line is **one commit** — small, shippable, green before the next starts. A task too
  large for one commit (`T-4`, `T-5`, `T-7`) says so and names its own sub-steps.
- **Done-when** is the merge gate: a test, a verified behavior, or an eyes-on.
- **WIP = 1.** Finish a commit and its done-when before starting the next.
- `[ ]` todo · `[~]` in progress · `[x]` done. **A `[x]` task leaves the open list** — it moves to
  [`archive/backlog-shipped.md`](archive/backlog-shipped.md) in the same commit that closes it. If it
  still carries an open obligation, that obligation gets its own `T-` number rather than living
  inside a done checkbox; five entries had drifted that way before the 2026-09-05 reset.
- **Task IDs are `T-<n>`, and they never appear outside a PR, a commit message, or `docs/`.** Not in
  source, comments, tests, or fixture data. The hyphen is required — bare `T1` collides with 320
  existing timestamp constants and cannot be guarded. IDs are never renumbered and never reused.
- **Verify tags:** **AUTO** = a machine gate the loop runs itself. **EYES-ON / AUDIO / REAL-ML / NET**
  = the loop implements and unit-covers, then flags for the human.
- Shared-contract changes stage `packages/shared` in the **same** commit.
- Canonical system design: [`ARCHITECTURE.md`](ARCHITECTURE.md). Agent onboarding and gotchas:
  [`HANDOFF.md`](HANDOFF.md). Historical source specs: [`archive/reference/`](archive/reference/).
