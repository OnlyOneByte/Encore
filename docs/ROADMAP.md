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
cd apps/core      && bun test          # 425 tests — MUST run from apps/core (drizzle resolves ./drizzle from cwd)
cd packages/shared && bun test         # 54
cd apps/worker    && python3 -m pytest # 142
cd apps/core      && bun run typecheck && bun run build
```

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

Three upstream projects were surveyed. **All three are MIT licensed**, so direct dependency,
vendoring, and copying with attribution are all open to us — no licence blocker anywhere.

| Project | Verdict | Why |
|---|---|---|
| [`python-audio-separator`](https://github.com/nomadkaraoke/python-audio-separator) | **Adopt as a dependency** | The separation engine under `karaoke-gen`, on PyPI. Wraps the UVR model family (MDX-Net, VR Arch, Demucs, MDXC/RoFormer). → **B-8** |
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

**Known cost, recorded honestly.** B-8 likely **supersedes `a76ab4a`** (the adaptive `-j` default,
measured 1.72× on 32 cores). Those numbers are `htdemucs`-specific and stop applying if the engine
changes. Re-benchmark rather than assuming they carry over.

**Not adopted.** `flacfetch`'s lossless sources (RED/OPS private trackers, Spotify via `librespot`)
would attack the real source-audio ceiling — YouTube gives us ~130–150 kbps lossy and everything
downstream inherits it. Parked deliberately: it needs a Transmission daemon plus tracker credentials,
and the sourcing question is the **owner's call, not the loop's**. Do not pick this up.

---

## Open queue

- [ ] **B-8 · Swap the separator to `python-audio-separator`** — the fit is clean because
  `demucs.py` is pure argv-plus-subprocess with **zero numeric imports**: the dial-home loop, job
  ledger and progress reporting do not move. Sub-commits:
  - [ ] **B-8-C1 · A/B spike, no production code.** Same source audio, `htdemucs` vs the default
        RoFormer, both stems kept. *Done-when:* both files exist and the owner has heard them.
        **EYES-ON/AUDIO** — this is the whole point; the loop cannot self-verify a cymbal.
  - [ ] **B-8-C2 · `SeparatorProcessor` behind the existing `Processor` protocol**, selected by
        `ENCORE_SEPARATOR` (`demucs` default, so the swap is opt-in and reversible).
        *Done-when:* a cook completes through the new processor and the TV plays its instrumental.
        **AUTO** — argv/params construction, model selection, progress parsing, missing-model error.
  - [ ] **B-8-C3 · re-benchmark and re-tune the parallelism knobs** for whichever engine wins;
        supersede or delete the `htdemucs` numbers in `config.py` rather than leaving them to rot.
        *Done-when:* the committed defaults match a measurement taken on the engine in use.
  - [ ] **B-8-C4 · device/acceleration config** mapped onto the library's backends, replacing the
        thin `ENCORE_DEMUCS_DEVICE` passthrough. **AUTO** — selection logic + explicit-override paths.

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
- Design docs: [`MASTER-DESIGN.md`](MASTER-DESIGN.md) · agent onboarding and gotchas:
  [`HANDOFF.md`](HANDOFF.md) · storage: [`media-storage-spec.md`](media-storage-spec.md).
