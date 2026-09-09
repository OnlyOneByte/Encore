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

## Ratified: the UI redesign — direction, palette, TV states (decided 2026-09-09)

**Nothing here is implemented yet.** These are owner rulings; the requirements they imply are in
[`ux/`](ux/README.md) (109 XR rows), and the work is tracked in GitHub issues. A pass proposing an
alternative to anything in this section is re-opening a ratified decision.

### Phone — direction A + B

The room's queue **is** the home screen. Now-playing is a hero, and a guest's own position is
stated **in words** ("3rd — you're up after Sam, roughly 11 minutes") rather than as a bare
number. Browsing is a deliberate push behind one primary button. From B: on the browse screen
**search is bottom-anchored** in the thumb zone and results stack upward — which **deletes** the
four concurrent filter mechanisms (3 readiness chips + artist rail + genre rail + re-announcing
group headers) rather than tidying them.

Rejected, recorded so they are not re-proposed: **C** (three cards per screen — ceiling hit too
fast) and **D** (queue drawn as people-in-rotation lanes — better at explaining round-robin, but
degrades past ~8 guests and exposes every guest's picks to the room).

**Drag reorder is additive, never a replacement.** SC 2.5.7 Dragging Movements (AA) requires a
single-pointer alternative, so the up/down buttons stay. Because `move`'s `toSeq` is an index into
*the singer's own* QUEUED picks, a guest's songs are **not adjacent** in a flat list — so drag must
enter a **mode** that dims other guests' rows and exposes only the guest's own legal slots. Do not
reintroduce the `cursor:grab` that was removed for appearing on another guest's song as the sole
affordance.

**Singing controls are LIVE controls for the currently-playing song**, on the now-playing hero —
not setup for an upcoming turn. That is what makes *who may touch them mid-song* a live authority
question rather than a hypothetical one.

### TV — split-panel attract, full roster lobby, full-screen takeovers

The playback join affordance folds into the **lower-third** (singer left, join right, one band,
stroked). That made lower-third reuse an **axis** for every other state: one chrome pattern means
nothing shifts when playback starts, and there is one thing to test rather than four.

- **Attract** is a **split panel** — an 820 px left column carrying a fixed `Karaoke` label above a
  rotating phrase, and a 600 px flat filled right panel carrying QR, URL and the room code at
  76 px. Nothing floats, nothing is centred.
- **Lobby** shows the **entire roster, no "+N more"**. Measured: 10 guests still fit two rows;
  headroom is ~12 before chip size must step down.
- **Transient states are full-screen takeovers**, one colour family each so they cannot be
  confused: **accent** for Next up (singer name the hero at 132 px), **warn** for Still cooking
  (bounded 3-step progress), **danger** for Skipping (names what is going *and* what replaces it).
  **The join block survives every takeover**, dimmed — a song change is exactly when a new guest
  looks up, so blanking the code then would lose the join path when it is most wanted.

**The attract phrase cycles as a shuffled bag** — a permutation reseeded per room, advanced every
8 s, reshuffled when exhausted, so no phrase repeats until all seven have shown. The `Karaoke`
label never rotates; it is the only thing telling a stranger what they are looking at. The box is a
**fixed two lines with content centred**, because one- and two-line phrases otherwise differ by
87 px and the column jumps on every tick. **Under `prefers-reduced-motion` the cycle stops** and
one phrase is held for the session — which is exactly Minecraft's splash behaviour, so the
accessible fallback is the reference rather than a lesser version of it. Measured admission rule:
**≤ 24 characters** (84 px/900 in 820 px; a 30-character control overflows to three lines).

**The TV cannot be themed to one player.** The stage is shared, so it keeps neutral chrome and
spends a player's colour only where it *identifies* someone — singer dot, roster chip, now-singing
line. This is the one surface where "your colour is your accent" does not apply.

### TV type floor — and it can land independently

```css
:root { font-size: calc(max(2.7vh, 20px) * var(--ui-scale)); }
```

Whole ladder in `rem` off that, so the floor lives in exactly one declaration. `--ui-scale` is a
persisted preference, 0.8–1.6.

`max()` of a `vh` and a `px` term because **you cannot detect which case you are in**, so you
satisfy both. Two corrections to earlier analysis, recorded so the wrong model is not inherited:

- **`vh` does not track resolution.** A TV browser presents a fixed CSS viewport regardless of
  panel pixels (Samsung: 1920×1080 for UHD groups, 1280×720 for FHD). `vh` is panel-proportional
  and very nearly **angle-preserving** — one CSS px on a full-panel 1080-tall viewport subtends
  ~0.70′ at 43″@8 ft, 55″@10 ft and 65″@12 ft alike.
- The real defect is that **coefficients are ~1.8× too small** (0.70′ is ~0.55× CSS's nominal 1.28′
  reference pixel, so body text needs 16 × 1.8 ≈ 29 px ≈ 2.7vh — independently reproducing Google's
  and Apple's 24 px TV starting point), and that **the viewport is not the panel when windowed**.

Also: `env(safe-area-inset-*)` is defined for **non-rectangular** displays, so a TV correctly
reports 0 and cannot help. A hardcoded percentage is the only option.

### Component library — shadcn-svelte + Tailwind

Chosen because **copy-in puts component CSS in `src/`**, where the source-scan design guards can
still see and edit it. A headless dependency moves that CSS into `node_modules`, where a 38 px
button, a 14 px input, a `vh` sheet cap and a `content: '✕'` all become **invisible rather than
illegal**. Scope reality: a library replaces **~1,060 of ~4,950** hand-written CSS lines (21%); the
~2,404-line TV tree is out of scope; the single clear win is `QueueSheet`.

**Tailwind restriction:** registering a colour in `@theme` mints the *whole* utility family, with
no per-family opt-out. Keep `--accent`, `--grad` and the player hues in `:root` and **never
register them**; use `@theme` for non-colour tokens only.

### Palette — Chromatic, 48 stops, player colour = UI accent

Each stop ships four values: `fill` (identity and accent), `onFill` (the only ink permitted on it),
`ink` (accent as text on a card), `accent2` (+42° hue, so the brand gradient is personal too).
Stops sit at equal cumulative OKLab distance with per-hue in-gamut chroma found by bisection, and
lightness following each hue's gamut cusp — which is what restores true yellow and true blue that
the rejected Uniform variant destroyed, and separates neighbours 1.6× better.

Consequences that must not be lost: `onFill` is **36 dark / 12 white**, per-stop and not one rule.
`ink` **differs from `fill` for 13 of 48**, so `--accent-ink` stays a required distinct token.
`--accent-strong` **loses its job** (with per-stop `onFill`, the fill *is* the strong value).
`--on-accent` **stops being a constant** and becomes per-stop, so the adjacency discipline matters
*more* — there are now 48 pairs. `--grad`'s decoration-only ban **stands** but becomes a per-stop
question. The picker becomes a **discrete 48-swatch grid**, because a colour *between* two stops
has no validated ink and no measured contrast. The colour **name** is the non-colour carrier of
identity for a colour-blind guest, so it stays visible in the picker and the roster.

**Status hues stay fixed and never follow the player.** 20 of 48 stops sit within 20° of a status
hue and **the owner accepted this** — do not reserve arcs, do not remove stops. Record the cost
accurately, because rendering it inverted the intuition: the **error survives** a same-hue accent
(its tint, border and pill carry it). What degrades is the **status pill's scannability**, worst for
**green**, because "Ready" is the most common badge in the app. The harm is not a false alarm — both
meanings are positive — it is that the chip stops being scannable, which is the only job it has.

### ⚠ Blocking correction found while specifying: six stops fail AA

The palette generator measured against `bg #060a18 / card #131a2e`. **`app.css` paints
`--bg: #0b0b12` and `--card: #1a1a28`.** Re-measured on the real tokens, six stops miss the 4.5
floor as accent-as-ink:

| Stop | vs real `--card` | vs mockup surface |
|---|---|---|
| Cobalt | **4.473** | 4.501 |
| Denim | **4.477** | 4.505 |
| Rose | **4.477** | 4.504 |
| Orchid | **4.481** | 4.509 |
| Magenta | **4.483** | 4.510 |
| Fuchsia | **4.490** | 4.517 |

The reported worst case was 4.50 — a margin of ~0.00 — so any surface drift at all was going to
cross it. **This is the same defect class as the `colors.test.ts` landmine**: a contrast measurement
bound to a duplicated surface value rather than to the token the app paints. The palette direction
is unaffected; the *numbers* must be regenerated with the app's real surfaces as the input, and the
generator must read them rather than restate them.

### ⚠ Correction: the rendered-DOM prerequisite is two rungs, not one

Aliasing `$app`/`$env` in the preload was recorded as converting measured tap geometry, clipping,
computed contrast and safe-area violation to checkable. **The measurement half is false.**
happy-dom 20.14.0's `getBoundingClientRect()` is a stub — `Element.js:795`, `// TODO: Not full
implementation`, `return new DOMRect()`, all zeros — and it has **no layout engine**.

So: **rung M** (mount — cascade, computed declared values, effects; unblocked by the aliasing) and
**rung L** (layout — real headless Chromium, already in-repo at `apps/core/e2e/cdp.mjs`). The four
measurement claims land on **rung L**. A plan that stops at rung M has made none of them checkable.

### Superseded: four "not decided" items were already decided

The design handoff listed these as open. They are not, and the mechanism in each case already
ships:

- **A host concept exists**, centralised in `server/auth/capabilities.ts` as `can(actor, cap)`,
  carrying the owner's dated ruling: *"Today every joined singer is a host. That is Angelo's call
  (2026-09-04) … there is no operator to be, and inventing an admin password for a party is worse
  than the exposure."* Gating it later is an edit **there and nowhere else**.
- **Cross-singer reorder already ships** — `move-global` ("a HOST reorder that can cross singers")
  and `unpin`, with a durable `pinnedSeq` column and `rotation.ts:placePins`, gated on
  `queue:reorder-any`. The within-singer rule still holds for the `move` op, but the *product* is no
  longer within-singer only.
- **A rate limit exists** — `MAX_CONCURRENT_COOKS_PER_SINGER = 3`, refused as `over-limit` and
  answered HTTP 429 with a phone-showable reason. The uncapped axis is **queue depth per singer**.
- **A lost optimistic race is already disclosed** — `hub.ts` emits `op:reject`, the queue store
  rolls back to the pre-op snapshot, and it surfaces as a `role="alert"` toast.

What remains open in all four is **policy content, not mechanism** — much cheaper than the handoff
assumed. Those are the named-decision rows in [`ux/05-concurrency.md`](ux/05-concurrency.md).

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
