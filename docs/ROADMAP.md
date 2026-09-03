# 🎤 Encore — Roadmap (open work only)

Status: **LIVING** · this file holds **what is left to build**. Everything shipped has moved to
[`archive/`](archive/) — go there for *why it is built this way*, never for *what to do next*.

- [`archive/milestones-m0-m8.md`](archive/milestones-m0-m8.md) — M0–M8, all closed.
- [`archive/backlog-shipped.md`](archive/backlog-shipped.md) — B-1, B-5, B-6, B-7, and B-3's shipped commits.

---

## START HERE — the auto-pilot contract

**What Encore is today.** A self-hosted karaoke server that works end to end: phone remote (QR join,
search, one-tap queue), TV/stage (gapless playback, room states, presence), a Demucs worker that
strips vocals on demand, word-timed lyrics with provenance labelling, and live mic scoring. Songs
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
bun test                              # 479 (425 core + 54 shared) — runs from the REPO ROOT
cd apps/worker && python3 -m pytest   # 142
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
- **No microphone** — live scoring is verified with a synthesized pitch stream.
- Demucs/WhisperX run in the worker container, ~1–2 min/song on CPU.
- Host ffmpeg (`/home/angryang/ffmpeg/ffmpeg`) is a **stripped 7.1.1 build**: no AAC encoder, no mp4
  muxer, no `ffprobe`. Use the **container's** ffmpeg (`docker exec`) for probing and transcoding.
- `yt-dlp` is **not baked into the worker image** — a `docker rm` loses it. See B-9.
- A long-lived Python process does **not** reload bind-mounted source; `docker restart` after editing
  worker code.
- YouTube autoplay-with-audio needs a user gesture in-browser.

**Working order.** **B-8** (separator swap) → **B-9** (image + stream-source hygiene) → **B-3-C7p2**
(captions) → **B-4** → **M9-C1** → **M9-C3** → **B-2** last. B-2 is last because its only real
acceptance test is audible and needs the owner in the room.

---

## Adopted: reuse from the nomadkaraoke tools (decided 2026-09-03)

Four upstream projects were surveyed. **All four are MIT licensed**, so direct dependency,
vendoring, and copying with attribution are all open to us — no licence blocker anywhere.

| Project | Verdict | Why |
|---|---|---|
| [`python-audio-separator`](https://github.com/nomadkaraoke/python-audio-separator) | **Adopt as a dependency** | The separation engine under `karaoke-gen`, on PyPI. Wraps the UVR model family (MDX-Net, VR Arch, Demucs, MDXC/RoFormer). → **B-8** |
| [`karaoke-lyrics-processor`](https://github.com/nomadkaraoke/karaoke-lyrics-processor) | **Adopt for half the job** | Length-bounds and cleans lyric lines. We keep its bounding/parens/punctuation and supply the boundary split it gets wrong. → **B-3-C8** (done) |
| [`flacfetch`](https://github.com/nomadkaraoke/flacfetch) | **Borrow one idea** | Its provider+ranking pattern already landed independently as `lyrics_chain.acquire()` + `pickBestLyrics`. Its stream-quality heuristic has not. → **B-9** |
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

**Why `karaoke-lyrics-processor` is only half adopted (B-3-C8).** It is a length-BOUNDER, not a
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

**Known cost, recorded honestly.** B-8 likely **supersedes `a76ab4a`** (the adaptive `-j` default,
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

## Open queue

- [ ] **B-8 · Swap the separator to `python-audio-separator`** — the fit is clean because
  `demucs.py` is pure argv-plus-subprocess with **zero numeric imports**: the dial-home loop, job
  ledger and progress reporting do not move.

  ### Decision re-opened and resolved, 2026-09-03: `audio-separator`, not `bs-roformer-infer`

  The shipped `roformer` engine (`apps/worker/src/roformer.py`) shells `bs-roformer-infer`, chosen
  over `python-audio-separator` for its `load/infer/release` session lifecycle, its sha256-verified
  repointable checkpoint registry, and a device contract that raises instead of silently downgrading
  to CPU. Those virtues are real. Measurement against the installed package retires the choice anyway:

  - **The session lifecycle — the headline reason — is not being used.** `BSRoformerSession` does not
    exist in 0.1.5, so `roformer.py` shells the CLI, which reloads the checkpoint per cook exactly
    like the library it was chosen over. Measured reload cost is 1.3–8.0s against a cook of minutes:
    immaterial either way.
  - **It cannot reach the fast models.** `bs_roformer.utils.get_model_from_config` implements only
    `model_type == 'bs_roformer'`; the package ships no mel-band module and its registry holds exactly
    ten models, none mel-band. The four fastest checkpoints measured are all mel-band.
  - **Its registry has no `ep_317_sdr_12.9755`** — the 2-stem checkpoint that was benchmarked and
    quality-approved. Token `bs-roformer-1297` resolves to `BS-Rofo-SW-Fixed.ckpt` ("BS Roformer SW
    by jarredou", category multi-stem): a different model, running in production under a label
    claiming otherwise. `audio-separator` serves the approved checkpoint directly.
  - **Token `mel-roformer-inst-v2` mapped to a slug absent from the registry** — a phone option no
    worker could ever satisfy. Removed from both whitelists. The test that should have caught it
    asserted only that the slug *started with* `"roformer-model-"`; it now asserts registry
    membership against a checked-in slug set.
  - **Neither tuning knob is reachable.** Its CLI exposes no overlap and no precision flag, and
    `inference.py` contains no autocast. Overlap is reachable only by hand-writing a config YAML and
    passing `--config_path`. `audio-separator` has `--mdxc_overlap` and `--mdxc_batch_size` as
    first-class flags.

  **Measured on the reference box** (32-core Graviton 3, CPU; realtime factor = wall-clock seconds per
  second of song, at each checkpoint's own defaults):

  | checkpoint | params | dim/depth | window | overlap | fp32 s/win | bf16 s/win | **rt** |
  |---|---|---|---|---|---|---|---|
  | htdemucs *(live default)* | 83M | conv | — | — | — | — | **0.29** |
  | htdemucs_ft | 83M×4 | conv | — | — | — | — | 0.55 |
  | mel instrumental_becruily | 228M | 384/6 | 8.0s | 2 | **5.14** | 7.09 | **1.28** |
  | mel kim_ft_unwa | 228M | 384/6 | 11.0s | 8 | 15.49 | 7.23 | 11.27 → 1.31 @ ov2+bf16 |
  | mel instrumental_gabox | 228M | 384/6 | 11.0s | 2 | 15.26 | 8.48 | 2.77 → 1.54 bf16 |
  | mel instrumental_bleedless_v3 | 228M | 384/6 | 11.0s | 2 | 15.99 | 10.16 | 2.91 → 1.85 bf16 |
  | mel ep_3005 *(classic)* | 252M | 384/12 | 8.0s | 4 | 7.92 | 14.52 | 3.96 → 1.98 fp32 ov2 |
  | bs_roformer 1297 *(current roformer default)* | 160M | 512/12 | 8.0s | 4 | 26.59 | 16.55 | **13.29** |

  A RoFormer-family instrumental cook goes from **43.8 min to 3.7 min on existing hardware** — 10.4×,
  no GPU involved. Three results that must survive into the implementation:

  1. **Wall-clock is linear in overlap.** 4→2 measured 1.83× on a 24s clip (253s→138s), per-window
     cost unchanged. It is a redundancy multiplier, not an execution detail.
  2. **Precision reverses per checkpoint.** bf16 is 1.6× faster on bs_roformer-1297 but 1.4–1.8×
     *slower* on the 8s-window mel models. fp16 on CPU is 6.5× slower than fp32 (179s vs 27.7s per
     window — no fp16 CPU kernels); fp16 is a GPU-only lever. There is no global dtype switch.
  3. **Parameter count is anti-correlated with cost.** A 228M mel-band model beats the 160M
     bs_roformer by 5.2× per window; `depth` and `dim` dominate. Never infer cost from file size.

  Also measured and *not* worth pursuing: `batch_size` 1→4 gave 1.02× (cores already saturated at
  batch 1); thread scaling 8→32 gave only 1.34× for 4× the cores, so this workload does not reward a
  bigger CPU; attention already runs on `scaled_dot_product_attention`; `torch.compile` fails to build
  in the worker image. Hardware ceilings are modest — the Arc A380 is 4.19 TFLOPS fp32 / 8.40 fp16
  against this box's ~2.2, and its 186 GB/s is *below* Graviton 3's ~300 GB/s — so **no engine here
  becomes live-tier by moving hardware**; RoFormer stays an upgrade tier and the goal is an upgrade
  that lands within a song or two.

  **What must carry over from `bs-roformer-infer`** — these were good reasons, and dropping the
  package must not drop them: pin the checkpoint set rather than accepting arbitrary ids; verify
  downloads by digest; and make an explicitly-requested-but-unavailable device raise at startup
  instead of cooking 50× slower on CPU (`backends.py` already implements that contract).

  **Done in this pass:** measured costs baked into `packages/shared/src/separators.ts`
  (`SeparatorCost` + `estimateCookSeconds`, so the UI can say "about four minutes" instead of
  "slow"), the unrunnable mel token removed from both whitelists, and the slug test strengthened.

  Sub-commits:
  - [x] **B-8-C1 · A/B spike, no production code.** Same source audio, `htdemucs` vs RoFormer.
        *Result:* htdemucs 50s, htdemucs_ft 95s, BS-RoFormer 2629s on a 2:51 song; owner heard both
        and ruled "RoFormer sounds better, htdemucs significantly faster → keep both, make it
        selectable". **EYES-ON/AUDIO** — done.
  - [ ] **B-8-C1b · listening test for the fast mel-band instrumental checkpoints.** Speed is
        measured; **quality is not**. `bs_roformer-1297` is the only candidate with a published SDR
        (12.9755) and the only one the owner has heard. Cook the same source with
        `instrumental_becruily`, `instrumental_gabox` and `kim_ft_unwa` and compare by ear before any
        of them is whitelisted. Checkpoints are cached in
        `.kiro/autopilot/encore-b8-b9-b3c7/model-cache`, so this costs no re-download and ~15 min.
        *Done-when:* the owner has ranked them. **EYES-ON/AUDIO** — a test cannot hear vocal bleed.
  - [ ] **B-8-C2 · `SeparatorProcessor` behind the existing `Processor` protocol**, selected by
        `ENCORE_SEPARATOR` (`demucs` default, so the swap is opt-in and reversible). Must pass the
        per-checkpoint `overlap` and precision through as real flags, and keep the pinned-checkpoint
        and raise-on-unavailable-device contracts above.
        *Done-when:* a cook completes through the new processor and the TV plays its instrumental.
        **AUTO** — argv/params construction, model selection, progress parsing, missing-model error.
  - [ ] **B-8-C3 · re-benchmark and re-tune the parallelism knobs** for whichever engine wins;
        supersede or delete the `htdemucs` numbers in `config.py` rather than leaving them to rot.
        Note `batch_size` and extra threads measured as near-worthless here — do not re-derive them
        from theory. *Done-when:* the committed defaults match a measurement taken on the engine in use.
  - [ ] **B-8-C4 · device/acceleration config** mapped onto the library's backends, replacing the
        thin `ENCORE_DEMUCS_DEVICE` passthrough. **AUTO** — selection logic + explicit-override paths.
        For the Arc box this is now a one-line index swap, not IPEX: `torch 2.8.0+xpu` plus matching
        `torchaudio 2.8.0` / `torchvision 0.23.0` are all published on
        `download.pytorch.org/whl/xpu` for cp312/linux_x86_64 — the exact versions already pinned. So
        the `IPEX_VERSION` build arg can go, and `docs/deploy/docker-compose.intel.yml` uses the
        ordinary Dockerfile; `docs/deploy/Dockerfile.intel` is parked as an IPEX fallback only. The host
        still needs the Intel compute runtime and `/dev/dri`. **Superseded as the live target:** the
        deploy box is now Windows + WSL2 + RTX 3080, where the equivalent is
        `docs/deploy/docker-compose.cuda.yml` and `backends.py` already probes `cuda` first, so no
        selection code changes at all. See `docs/DEPLOY-WSL2.md`.

- [ ] **B-9 · Source-audio and image hygiene** — two small independent fixes:
  - [ ] **B-9-C1 · bake `yt-dlp` into the worker image.** It is currently pip-installed at runtime,
        so any `docker rm` silently breaks downloads. *Done-when:* a freshly recreated container
        resolves `yt-dlp` on PATH with no manual step. **AUTO** — image build + a resolve check.
  - [ ] **B-9-C2 · stream-selection heuristic** (idea from `flacfetch`). We take whatever
        `-f bestaudio` returns, which on an old upload can be legacy AAC when a better stream exists.
        Prefer newer Opus over legacy AAC, and prefer official/"Topic"/"Official Audio" uploads.
        *Done-when:* for a title with both, the Opus stream is chosen. **AUTO** — pure ranking over
        recorded format lists; no network in the test.

- [ ] **B-3-C7 (part 2) · captions tier + re-align on better text.** The backfill covers "no lyrics
  yet"; this covers "LRCLIB became reachable, or the text was corrected". Captions were probed on two
  library videos: one had none, the other only auto-generated — so this is a **middle** tier, not an
  authoritative one. *Done-when:* a song whose text improves gets re-aligned **from retained audio**
  (no re-download, no re-separation) and can never regress from word- to line-level timings.
  **AUTO** — tier ordering, upgrade-not-regress invariant, re-align trigger.

- [ ] **B-4 · Hot-titles persistence** — the popularity tracker is in-memory (survives refresh, not
  restart). Persist counts so "🔥 Popular tonight" survives a restart. **AUTO** — unit.

- [ ] **M9-C1 · accounts** — an ephemeral singer can "claim" an account (OAuth or local).
  *Done-when:* claiming works and **nothing about the join flow regresses**.

- [ ] **M9-C2 · history + favorites** — *Done-when:* re-queue a saved karaoke instantly (skips the
  worker). Largely covered by B-1's library; what is left is per-account history and favorites.

- [ ] **M9-C3 · multi-room** — room codes, per-room topics. *Done-when:* two independent rooms run on
  one core. Tag **v1.0.0**.

- [ ] **B-2 · WebAudio pitch-shift (semitones)** — ±key currently **no-ops on the TV**. Add a
  client-side phase-vocoder AudioWorklet so `keyShift` re-pitches the instrumental live with tempo
  preserved, and wire `keyShift` into `TvPlayer`. *Done-when:* ±1 semitone audibly shifts pitch
  without changing tempo. **AUTO** — cents→ratio and framing math; **EYES-ON/AUDIO** — the shift
  itself. Last in the order for exactly that reason.

---

## B-3 design notes (the part still worth reading)

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

- **Human lyrics review UI** (idea from `karaoke-gen`, which treats review as a first-class pipeline
  stage). Well-motivated: C6 shipped provenance *labelling*, and review is the next rung up, with
  `SOURCE_MANUAL` already reserved in `lyrics_chain.py` for it to populate. Needs a core endpoint +
  phone UI + storage, so it is a feature, not a commit.
- **Lossless source audio via trackers/Spotify** (`flacfetch`) — see above; the owner's call.
- **M8-C4 · end-of-song score reveal + session leaderboard** — deferred 2026-09-02 to close M8. Live
  scoring already works on both surfaces, so this is presentation polish on a capability that exists.
  Carries the **v0.3.0 (scoring)** tag if revived.
- **VBR or mono for the vocals stem** — it is CBR 192k today, so silence costs the same as singing.
- **Re-encoding `audio/`** — still ~494 MB of pre-policy WAV. It is the only **unrecoverable** class,
  so touching it is the owner's call.

---

## Conventions

- Each checklist line is **one commit** — small, shippable, green before the next starts.
- **Done-when** is the merge gate: a test, a verified behavior, or an eyes-on.
- **WIP = 1.** Finish a commit and its done-when before starting the next.
- `[ ]` todo · `[~]` in progress · `[x]` done.
- **Verify tags:** **AUTO** = a machine gate the loop runs itself. **EYES-ON / AUDIO / REAL-ML / NET**
  = the loop implements and unit-covers, then flags for the human.
- Shared-contract changes stage `packages/shared` in the **same** commit.
- Canonical system design: [`ARCHITECTURE.md`](ARCHITECTURE.md). Agent onboarding and gotchas:
  [`HANDOFF.md`](HANDOFF.md). Historical source specs: [`archive/reference/`](archive/reference/).
