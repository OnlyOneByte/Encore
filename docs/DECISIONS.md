# Encore — Decisions and fences

> **Purpose.** Ratified design decisions, the deliberately-parked scope fence, and the lyrics-chain
> model. This is *why the shape is what it is* and *what not to pick up* — the reasoning the canonical
> docs deliberately do not carry. Open work is tracked in **GitHub issues**; how the system works now
> is [`ARCHITECTURE.md`](ARCHITECTURE.md); how to operate it safely is [`HANDOFF.md`](HANDOFF.md).

---

## Adopted: reuse from the nomadkaraoke tools (decided 2026-09-03)

Four upstream projects were surveyed. **All four are MIT licensed**, so direct dependency,
vendoring, and copying with attribution are all open to us — no licence blocker anywhere.

| Project | Verdict | Why |
|---|---|---|
| [`python-audio-separator`](https://github.com/nomadkaraoke/python-audio-separator) | **Adopt as a dependency** | The separation engine under `karaoke-gen`, on PyPI. Wraps the UVR model family (MDX-Net, VR Arch, Demucs, MDXC/RoFormer). |
| [`karaoke-lyrics-processor`](https://github.com/nomadkaraoke/karaoke-lyrics-processor) | **Adopt for half the job** | Length-bounds and cleans lyric lines. We keep its bounding/parens/punctuation and supply the boundary split it gets wrong. → shipped |
| [`flacfetch`](https://github.com/nomadkaraoke/flacfetch) | **Borrow one idea** | Its provider+ranking pattern already landed independently as `lyrics_chain.acquire()` + `pickBestLyrics`. Its stream-quality heuristic has not. → shipped |
| [`karaoke-gen`](https://github.com/nomadkaraoke/karaoke-gen) | **Ideas only, no dependency** | Mostly scope we do not want (4K render, CDG packaging, YouTube/Dropbox upload). Its **human review stage** is the keeper. → **Deferred** |

**Adopted ALONGSIDE `bs-roformer-infer` — both engines, not one over the other (issue #483, owner
ruling Q1(b)).** The ruling is settled. The dependency is **adopted but NOT YET LANDED**: on this
commit there is no `python-audio-separator` pin in `apps/worker/requirements.txt` and no
audio-separator engine in `apps/worker/src/separation/engines.py`, and #483 is still open as the unit
of work that lands it. When it lands it JOINS `bs-roformer-infer` rather than replacing it, selected
per job (`params.engine`) through `engine_for` — the seam both engines will resolve behind.
`bs-roformer-infer` is retained for its load/infer/release session lifecycle (load the ~700 MB
checkpoint ONCE per long-lived worker, not per cook) and its repointable sha256-verified checkpoint
registry. **This is ratified: a pass proposing to drop one of the two engines is re-opening a
ratified decision.** Equally, a pass that finds only one separator engine on disk has found unlanded
work, not a contradiction of this ruling. That includes the `#: KNOWN MISMATCH` note in
`apps/worker/src/separation/roformer.py` about the approved `ep_317` checkpoint being unreachable
through `bs-roformer-infer` — a model-registry gap, not a case for removing the engine.
`bs-roformer-infer`'s own pin comment carries the same reason at `apps/worker/requirements.txt`.

**Why adding `python-audio-separator` is the highest-value change.** Two independent wins from one
dependency:
1. **Instrumental quality.** The owner reports crash-cymbal artifacts on a 5.1.2 system. That damage
   is done by `htdemucs`' vocal mask, and **no codec change reaches it** — FLAC cannot recover what
   separation discarded. A better model is the only lever that does.
2. **Lyrics quality, for free.** The ASR tier transcribes the **vocals stem**. Cleaner separation →
   better transcribed text → a better `agreement_score` signal → better `pickBestLyrics` ranking. It
   improves the lyrics chain without touching it.

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

**Validated against this repo's own artifacts, not just synthetic text.** Of the over-long lines in
this repo's ASR artifacts, a first version splitting only on sentence ends and `", <conjunction>"` left
**91% untouched**. Whisper is *not* unpunctuated (83% of those lines carry `.,!?`) but its full stop
lands at the END of a segment with nothing after it to split off. Adding a greedy re-pack at **bare
commas** (whisper puts them at breath boundaries) and a **capitalised line-opener** rule took the share
fully resolved with no bisection from **3% → 47%**, and improved **8% → 71%**. Openers are a CLOSED set
of function words and imperatives, because "any capital" breaks `"the rains down in | Africa"`. The
remainder is genuinely structureless (vocalisations, whisper repetition), where bisection is the only
honest answer.

Gated on `is_authoritative_text`, so **only auto-transcribed text is touched** — every authoritative
tier already arrives line-broken by a human, and a splitter can only damage those.

**Installed `--no-deps`.** A plain install resolves to 30 packages, 29 unused — its declared
`textract-py3` drags SpeechRecognition, pdfminer.six, python-pptx, oletools, cryptography, easygui,
xlrd; all serving `.doc`/`.rtf` ingestion we never call. Unused weight, not a version conflict.

**Partially superseded (2026-09-07, issue #427).** `flacfetch`'s lossless sources (private trackers,
Spotify via `librespot`) would attack the real source-audio ceiling — YouTube gives us ~130–150 kbps
lossy — but that ACQUISITION path needs a Transmission daemon plus tracker credentials and stays
**parked** (still the owner's call). What the owner DID adopt is **Spotify as a SEARCH / metadata
source only**: a Spotify resolver joins the `/api/search` fan-out and surfaces clean canonical
artist/title/duration (where a YouTube upload title has to be reverse-engineered), but its bytes are
never pulled from Spotify — the audio is still acquired from YouTube, consistent with the annotator
rule below. There is deliberately no `fetch:spotify` worker capability and no `librespot`; a
spotify-sourced media is not cookable — `isCookableSource` (`packages/shared/src/fetchers.ts`) is the
one authority that says so, and every layer that decides whether a cook is possible asks it:
`cookState` answers `not-cookable`, the phone's `canCook` withholds the Sing and Add affordances, and
`requestMakeKaraoke` declines. (`fetcherFor` does NOT refuse a spotify source — it returns the default
downloader as a floor. The DECISION here is unchanged; only this sentence describing how it is
enforced was wrong, which is #742.)
Credentials, if the Spotify search API needs them, live in worker/core **env vars**
(`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`), matching LRCLIB and every existing knob — this app
stores no secrets in the DB and this does not become the first. So the librespot ACQUISITION half of
this line remains not adopted; only the search half is superseded.

---

## Ratified: metadata, acquisition, and processed-only playback (decided 2026-09-03)

**Shipped and verified.** The durable explanation lives in [`ARCHITECTURE.md`](ARCHITECTURE.md) §6–§7.
The decisions, so they are not re-litigated:

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
partial and the recording is chosen by duration. A trustworthy album needs a second release-group
lookup; until then D4 applies.

**Known gap, not a bug to rediscover.** Media materialised *before* canonicals were parsed at
materialize time never got them, and search reuses an existing row rather than re-materialising it — so
those songs are never annotated without a backfill pass.

---

## Lyrics-chain design notes

The chain is built; this is the model it settled on, because it is easy to get wrong when extending it.
The current-system summary is [`ARCHITECTURE.md`](ARCHITECTURE.md) §8; this keeps the reasoning.

**Text quality and timing fidelity are INDEPENDENT axes.**

| Source | Text | Timing it yields unaided |
|---|---|---|
| LRCLIB `syncedLyrics` (LRC) | authoritative | **line-level** — no ML, no audio at all |
| LRCLIB plain / YouTube captions | good | none — needs forced alignment |
| ASR on the vocals stem | **dubious** | line-level (segment bounds) |

**Corrected by measurement:** ASR does **not** yield word-level timing. Whisper's `transcribe()` returns
segment bounds and **zero words**; word timings come only from the separate `align()` pass. So **the
aligner is the single source of word timings for every tier** — one timing layer, N text sources.

Consequences that shape any change here:
- **Line-level sync is the floor, word-level the ideal.** Raw LRC clears the floor with zero ML and
  zero audio, so lyrics can be ready *before* the instrumental.
- **ASR always runs, not just as a fallback** — it is a validation signal. LRCLIB's real failure mode
  is a confident *wrong* match, and comparing ASR of what is actually sung against the looked-up text
  is what catches it. It also supplies the `language` that `align()` would otherwise guess as `'en'`.
- **Ranking puts authoritative-text-with-line-timings ABOVE ASR-text-with-word-timings.** Wrong words
  are a failure — you cannot sing them; correct words with coarse highlighting is the accepted minimum.
- **ASR is the worst tier for words while looking the most finished.** So provenance labelling matters
  *most* exactly where the output looks most polished.

---

## Deferred — do NOT pick these up

Parked deliberately. These return only if the owner says so.

- **Audio-REACTIVE visualizers** — the time-driven ones shipped; making them respond to the sound did
  not. What shipped: four renderers (plasma, starfield, ripples, phase curves) as pure functions of `t`,
  selectable per room. What is still parked, and why each was designed *around* rather than solved:
  - *Real FFT.* Still needs an `AudioContext` on the TV. `/tv` has no gesture handler, but `TvPlayer`
    also swallows its autoplay rejection, so the app *already* depends on the TV permitting unmuted
    autoplay — an `AudioContext` is the same bet, not a new one. The real work is the graph: one
    `MediaElementAudioSourceNode` per `<video>` (two slots, each recreated when its `{#if}` toggles),
    following whichever slot is audible across a gapless swap, and reaching `ctx.destination` or **the
    song goes silent**. See HANDOFF gotcha 18.
  - *`bars` and `scope`.* Deliberately absent from `TV_VISUALIZERS`, and a test pins the exclusion by
    id. They assert they are drawing the signal; nothing reads it. They arrive **with** real analysis or
    not at all — and that test is the thing to delete, on purpose, in the commit that adds it.
  - *Score-reactive modulation.* Has no data to react to at all: scoring was REMOVED outright.
  - *Visualizers on the no-lyrics screens* (lobby, `waiting`, interstitial). The ratified band for
    backgrounds is playing-only; extending it is a separate decision.
  One incidental note that is load-bearing for any FFT work: it is possible at all only because
  `TvPlayer.fileSrc` hardcodes `/media/${ref}` instead of `MediaStore.url(ref)`, so the media element is
  always same-origin. Switch the TV to presigned object-store URLs and every FFT visualizer silently
  goes flat with no error.
- **Milkdrop-class WebGL preset rendering.** A hand-rolled fragment shader if ever, not `butterchurn`:
  this project vendored Lucide *path geometry* rather than accept a webfont, to stay offline-LAN-safe.
- **Human lyrics review UI** (idea from `karaoke-gen`). Provenance *labelling* shipped; review is the
  next rung up, with `SOURCE_MANUAL` already reserved in `lyrics_chain.py`. Needs a core endpoint +
  phone UI + storage, so it is a feature, not a commit.
- **Lossless source audio via trackers/Spotify** (`flacfetch`) — see above; the owner's call.
- **Scoring, redesigned from scratch** — the original implementation was REMOVED. The research is in
  [`docs/research/scoring.md`](research/scoring.md): derive a per-word note grid from the vocals stem +
  align timings, DTW-align the singer, score multi-axis with pitch as ~half, and let a room setting pick
  a TIER. Blocked on the capture problem: a phone mic in a loud room hears the backing track, and every
  credible system solves that with hardware, not software.
- **VBR or mono for the vocals stem** — it is CBR 192k today, so silence costs the same as singing.
- **Re-encoding `audio/`** — still ~494 MB of pre-policy WAV. It is the only **unrecoverable** class,
  so touching it is the owner's call.
