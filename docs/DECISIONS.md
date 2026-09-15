# Encore — Decisions and fences

> **Purpose.** Ratified design decisions, the deliberately-parked scope fence, and the lyrics-chain
> model. This is _why the shape is what it is_ and _what not to pick up_ — the reasoning the canonical
> docs deliberately do not carry. Open work is tracked in **GitHub issues**; how the system works now
> is [`ARCHITECTURE.md`](ARCHITECTURE.md); how to operate it safely is [`HANDOFF.md`](HANDOFF.md).

---

## Adopted: reuse from the nomadkaraoke tools (decided 2026-09-03)

Four upstream projects were surveyed. **All four are MIT licensed**, so direct dependency,
vendoring, and copying with attribution are all open to us — no licence blocker anywhere.

| Project                                                                                | Verdict                       | Why                                                                                                                                                       |
| -------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`python-audio-separator`](https://github.com/nomadkaraoke/python-audio-separator)     | **Adopt as a dependency**     | The separation engine under `karaoke-gen`, on PyPI. Wraps the UVR model family (MDX-Net, VR Arch, Demucs, MDXC/RoFormer).                                 |
| [`karaoke-lyrics-processor`](https://github.com/nomadkaraoke/karaoke-lyrics-processor) | **Adopt for half the job**    | Length-bounds and cleans lyric lines. We keep its bounding/parens/punctuation and supply the boundary split it gets wrong. → shipped                      |
| [`flacfetch`](https://github.com/nomadkaraoke/flacfetch)                               | **Borrow one idea**           | Its provider+ranking pattern already landed independently as `lyrics_chain.acquire()` + `pickBestLyrics`. Its stream-quality heuristic has not. → shipped |
| [`karaoke-gen`](https://github.com/nomadkaraoke/karaoke-gen)                           | **Ideas only, no dependency** | Mostly scope we do not want (4K render, CDG packaging, YouTube/Dropbox upload). Its **human review stage** is the keeper. → **Deferred**                  |

**Adopted ALONGSIDE `bs-roformer-infer` — both engines, not one over the other (owner
ruling Q1(b)).** The ruling is settled, and the dependency has **LANDED**: `python-audio-separator` is
pinned in `worker/requirements.txt` and the `audiosep` engine is wired in
`worker/src/separation/engines.py` (`engine_for` resolves `demucs`, `roformer` and now
`audiosep`). It JOINS `bs-roformer-infer` rather than replacing it, selected per job
(`params.engine`) through `engine_for` — the seam both engines resolve behind. The two coexist behind
one seam; when the mel-band engine is added, it does not replace the roformer one.
`bs-roformer-infer` is retained for its load/infer/release session lifecycle (load the ~700 MB
checkpoint ONCE per long-lived worker, not per process) and its repointable sha256-verified checkpoint
registry. **This is ratified: a pass proposing to drop one of the two engines is re-opening a
ratified decision.** Equally, a pass that finds only one separator engine on disk has found unlanded
work, not a contradiction of this ruling. That includes the `#: KNOWN MISMATCH` note in
`worker/src/separation/roformer.py` about the approved `ep_317` checkpoint being unreachable
through `bs-roformer-infer` — a model-registry gap, not a case for removing the engine.
`bs-roformer-infer`'s own pin comment carries the same reason at `worker/requirements.txt`.

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
**91% untouched**. Whisper is _not_ unpunctuated (83% of those lines carry `.,!?`) but its full stop
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

**Partially superseded (2026-09-07, issue an earlier change).** `flacfetch`'s lossless sources (private trackers,
Spotify via `librespot`) would attack the real source-audio ceiling — YouTube gives us ~130–150 kbps
lossy — but that ACQUISITION path needs a Transmission daemon plus tracker credentials and stays
**parked** (still the owner's call). What the owner DID adopt is **Spotify as a SEARCH / metadata
source only**: a Spotify resolver joins the `/api/search` fan-out and surfaces clean canonical
artist/title/duration (where a YouTube upload title has to be reverse-engineered), but its bytes are
never pulled from Spotify — the audio is still acquired from YouTube, consistent with the annotator
rule below. There is deliberately no `fetch:spotify` worker capability and no `librespot`; a
spotify-sourced media is not processable — `isProcessableSource` (`src/lib/contract/process/fetchers.ts`) is the
one authority that says so, and every layer that decides whether a process is possible asks it:
`processState` answers `not-processable`, the phone's `canProcess` withholds the Sing and Add affordances, and
`requestProcess` declines. (`fetcherFor` does NOT refuse a spotify source — it returns the default
downloader as a floor. The DECISION here is unchanged; only this sentence describing how it is
enforced was wrong, which is an earlier change.)
Credentials, if the Spotify search API needs them, live in worker/core **env vars**
(`SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`), matching LRCLIB and every existing knob — this app
stores no secrets in the DB and this does not become the first. So the librespot ACQUISITION half of
this line remains not adopted; only the search half is superseded.

---

## Ratified: metadata, acquisition, and processed-only playback (decided 2026-09-03)

**Shipped and verified.** The durable explanation lives in [`ARCHITECTURE.md`](ARCHITECTURE.md) §6–§7.
The decisions, so they are not re-litigated:

| #   | Decision                                                                                                                                                                                                    | Ratified |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| —   | **MusicBrainz is an annotator, not a catalog.** Search stays yt-dlp; identification runs after the download and only enriches a media that already exists.                                                  | yes      |
| —   | **Nothing plays unprocessed.** No embed path, no raw-source path, no per-source exception for local files. `playMode` is gone.                                                                              | yes      |
| —   | **One row per song is NOT a requirement.** With best-effort identification, grouping two uploads is probabilistic, and merging on a weak signal collapses two different songs. No Song table, no `songKey`. | yes      |
| D4  | **Refuse rather than guess.** A weak match keeps the normalizer's values and records nothing.                                                                                                               | yes      |
| D7  | Columns-only migration; no sidecar re-shape (`playMode` was derived on read, never stored).                                                                                                                 | yes      |
| D9  | Confidence from duration: ±2s → `high`, ±5s → `medium`, else nothing. ±2s because that is LRCLIB's own matching tolerance.                                                                                  | yes      |

**Withdrawn, with the cost named.** The Song/Version split, the versions popup, a per-song default
rendition, and lyrics text shared across renditions were all specced and then cut. The one that actually
costs something: **source-fidelity upgrades are no longer expressible.** A better source is a different
`sourceRef` and therefore a different row, with no link to the old one, so "re-acquire from a better
source, then re-process" cannot be modelled. `sourceFidelity` is still worth recording as provenance, but
it is not a rung of the upgrade ladder.

**Album and year are deliberately not taken from MusicBrainz.** Measured live they resolved "Take On Me"
to a 1991 hits compilation and "Bohemian Rhapsody" to an undated bootleg — a search hit's release list is
partial and the recording is chosen by duration. A trustworthy album needs a second release-group
lookup; until then D4 applies.

**Known gap, not a bug to rediscover.** Media materialised _before_ canonicals were parsed at
materialize time never got them, and search reuses an existing row rather than re-materialising it — so
those songs are never annotated without a backfill pass.

---

## Lyrics-chain design notes

The chain is built; this is the model it settled on, because it is easy to get wrong when extending it.
The current-system summary is [`ARCHITECTURE.md`](ARCHITECTURE.md) §8; this keeps the reasoning.

**Text quality and timing fidelity are INDEPENDENT axes.**

| Source                          | Text          | Timing it yields unaided                |
| ------------------------------- | ------------- | --------------------------------------- |
| LRCLIB `syncedLyrics` (LRC)     | authoritative | **line-level** — no ML, no audio at all |
| LRCLIB plain / YouTube captions | good          | none — needs forced alignment           |
| ASR on the vocals stem          | **dubious**   | line-level (segment bounds)             |

**Corrected by measurement:** ASR does **not** yield word-level timing. Whisper's `transcribe()` returns
segment bounds and **zero words**; word timings come only from the separate `align()` pass. So **the
aligner is the single source of word timings for every tier** — one timing layer, N text sources.

Consequences that shape any change here:

- **Line-level sync is the floor, word-level the ideal.** Raw LRC clears the floor with zero ML and
  zero audio, so lyrics can be ready _before_ the instrumental.
- **ASR always runs, not just as a fallback** — it is a validation signal. LRCLIB's real failure mode
  is a confident _wrong_ match, and comparing ASR of what is actually sung against the looked-up text
  is what catches it. It also supplies the `language` that `align()` would otherwise guess as `'en'`.
- **Ranking puts authoritative-text-with-line-timings ABOVE ASR-text-with-word-timings.** Wrong words
  are a failure — you cannot sing them; correct words with coarse highlighting is the accepted minimum.
- **ASR is the worst tier for words while looking the most finished.** So provenance labelling matters
  _most_ exactly where the output looks most polished.

---

## Ratified: the UI redesign — direction, palette, TV states (decided 2026-09-09)

These are owner rulings; the requirements they imply are in [`ux/`](ux/README.md) (105 XR rows), and
the work is tracked in GitHub issues. A pass proposing an alternative to anything in this section is
re-opening a ratified decision.

**Implementation status, as of 2026-09-09 (this section originally read "nothing here is implemented
yet", which stopped being true within hours).** The palette, the token scales, the guard layer, the
phone direction A+B, the drag mode and the authority rulings all shipped. **The two largest
user-visible items did not:** the TV type floor (— a clamp ladder shipped instead, and
`--ui-scale` does not exist in code) and the TV states plus the attract phrase system (— the
screens exist in a pre-redesign shape). Both were undispatchable for a labelling reason rather than a
technical one. Check the issue before assuming a decision below is live in the product.

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
_the singer's own_ QUEUED picks, a guest's songs are **not adjacent** in a flat list — so drag must
enter a **mode** that dims other guests' rows and exposes only the guest's own legal slots. Do not
reintroduce the `cursor:grab` that was removed for appearing on another guest's song as the sole
affordance.

**Singing controls are LIVE controls for the currently-playing song**, on the now-playing hero —
not setup for an upcoming turn. That is what makes _who may touch them mid-song_ a live authority
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
  confused: **accent** for Next up (singer name the hero at 132 px), **warn** for Still processing
  (bounded 3-step progress), **danger** for Skipping (names what is going _and_ what replaces it).
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
spends a player's colour only where it _identifies_ someone — singer dot, roster chip, now-singing
line. This is the one surface where "your colour is your accent" does not apply.

### TV type floor — and it can land independently

```css:root { font-size: calc(max(2.7vh, 20px) * var(--ui-scale)); }

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
illegal**. **Scope — REVISED 2026-09-09.** This section previously read _"a library replaces ~1,060 of
~4,950 hand-written CSS lines (21%); the ~2,404-line TV tree is out of scope; the single clear win is
`QueueSheet`."_ Both halves of that justification are now dead: **an earlier change deleted `QueueSheet`**, and the
copy-in rationale had already been retracted in place for the drawer (see the correction directly
below). That left a toolchain installed, fenced and guarded since an earlier change and used by **nothing**.

The owner's ruling is to **adopt shadcn-svelte for the primitive layer across the app** — 42 buttons,
21 inputs, 16 selects, 11 range inputs and the alert/disclosure surfaces, sliced S0–S5. What
stays hand-rolled is not "not yet" but **not ever, unless something changes**: the whole TV tree (a
ten-foot surface with its own type ladder has no business borrowing phone primitives), `SongRow`,
`RangeBar`, and the composites `NowPlayingHero` / `ProcessingCard` / `QueueRow` — whose _primitives_
migrate while the components themselves remain.

> **`NowPlayingHero` has since been replaced** (`ui/phone-remote-redesign`). Its job moved into
> `src/lib/components/NowPlayingDrawer.svelte`, a bottom drawer mounted from `src/routes/+layout.svelte`,
> so the fence above now protects one fewer composite: the drawer's shell is the vendored
> `Drawer.Content` rather than a hand-rolled surface, which is the outcome the fence was meant to allow
> when "something changes".

Two constraints discovered while building S1, both structural rather than stylistic:

- **A copied-in component cannot be styled from its call site.** `app.css` sets Tailwind to
  `source(none)` with a single `@source '../src/lib/components/ui/**/*.svelte'`, so a utility written in
  a page is scanned by nothing and emitted nowhere — verified by building with a `w-full` at a call site
  and finding no `.w-full` rule in any of the 16 built CSS assets. Svelte's scoped CSS cannot reach in
  either, because a class a page passes down carries no scoping attribute for that page's `<style>`.
  **Both roads are closed, so every call-site difference becomes a named variant**, and page-level
  layout stays on a wrapper element in the page. That is a stricter discipline than shadcn's usual
  utility-soup-at-the-call-site, and it is the better one.
- **Colour cannot come from `@theme`.** Registering a colour mints the whole utility family, so
  `--color-accent` would hand out `text-accent` beside `bg-accent`, and `--accent` measures 3.10:1 as
  ink on `--card2` — below AA, which is why `--accent-ink` exists. Colour therefore arrives as arbitrary
  values over `:root` tokens (`bg-[var(--accent)]`), which need no registration and cannot mint an
  illegal sibling. `lib/tailwind-toolchain.test.ts` reds if a colour is ever registered.

**Correction — the rationale above does NOT hold for the drawer, which is the one component this
decision names as the clear win.** Measured in the an earlier change spike, on the pinned
`vaul-svelte@1.0.0-next.7`: shadcn's drawer copies 12 files with **zero `<style>` blocks**, so
nothing lands in `src/lib/components/ui/` for a design scan to read even though an earlier change created that
directory; the real CSS is a 291-line `<style global>` at
`node_modules/vaul-svelte/dist/components/drawer/drawer.svelte:92-383`, which `test-helpers.ts`'s
`SKIP_DIRS` skips by name. Worse, the sheet's **geometry is not CSS at all**: vaul computes each snap
point's offset in JS (`dist/use-snap-points.svelte.js:44-54`) and writes an inline `transform`, which
outranks any stylesheet rule, and its motion duration is a hardcoded `TRANSITIONS.DURATION = 0.5`
with no prop to override it — where the incumbent's own transition is `0.28s`. The decision to adopt
anyway (Q1 · C on an earlier change: accept the hole, on the record) stands; what is retracted is the claim that
adoption costs no guard coverage here. The two named assertions it will red are recorded in advance
in `tests/guards/meta/non-vacuity-floors.test.ts`'s `PENDING_RULING`. Compounding it from the other
side: Preflight is off (below), so a copied-in drawer cannot assume the reset ran either — it arrives
with neither the utilities' reset nor a readable stylesheet of its own.

**Tailwind restriction:** registering a colour in `@theme` mints the _whole_ utility family, with
no per-family opt-out. Keep `--accent`, `--grad` and the player hues in `:root` and **never
register them**; use `@theme` for non-colour tokens only.

#### Installed configuration (decided 2026-09-09)

Three questions the adoption above left open, each settled by measurement rather than preference.
`tests/guards/design-system/tailwind-toolchain.test.ts` pins all three, so none can be reversed silently.

**The Vite plugin, not PostCSS.** `@tailwindcss/vite` was a real question because this app runs
**Vite 8**, and the plugin only widened its peer range to `^8` in **4.2.2** — every release up to
4.2.1 declares `^5.2.0 || ^6 || ^7`. Pinned at **4.3.3**, verified by a real `bun run build` against
**Vite 8.1.0**, so the authorised PostCSS fallback is unused. Tailwind v4 configures through
**`@theme` in CSS**, so there is no `tailwind.config.ts` at all — a JS config would be the v3 shape.

**Preflight is DISABLED** (option A). Not a preference: `e2e/probes/preflight-reset-audit.mjs` reads
the 36 computed properties Preflight writes on every element of 8 surfaces, and enabling it moved
**2,696 of ~3,200 boxes** — 1,167 of 1,201 on `/components` alone, largest displacement 264 px. Named
fallout: **74 `<h2>` headings** dropped from weight 700 to 400 and lost their bottom margin (Preflight
unstyles every heading), 75 buttons lost padding, 24 buttons and 21 inputs changed colour via
`color: inherit`, and the lyrics overlay's `.word.done` changed hue. Most of that is Preflight
_undoing_ deliberate styling rather than supplying anything missing — `app.css` already sets
`box-sizing: border-box` on `*` itself, which is Preflight's largest single contribution. Option B
(enable it, fix the fallout) stays available as its own issue once the redesign surfaces settle;
taking it now would put a global restyle underneath four issues already contending on
`routes/+page.svelte`. **Consequence:** a copied-in component cannot assume the reset ran.

**Utilities are minted from the copy-in target only** — `source(none)` plus one `@source`, scoped to
`.svelte` files under `src/lib/components/ui/`. Tailwind's auto-detection scans the whole project and
mints a utility for any token that parses as one, **including tokens in tests and markdown**. It
emitted 50 that way, and two collided
with class names the app really applies: `.underline` painted a genuine `text-decoration-line` on the
lyrics ball (`class="ball {ball}"` with `ball === 'underline'`), and `.block` was saved only by the
app's own `.ball.block` outranking it on specificity. `ball` is a **room setting whose values are
English words**, so that is a family exposure, not two unlucky names. The `*.svelte` half of the glob
matters too: scoped to the bare directory, `.underline` came back out of `ui/README.md`, which names
it in prose in order to warn about it.

### Palette — Chromatic, 48 stops, player colour = UI accent

Each stop ships four values: `fill` (identity and accent), `onFill` (the only ink permitted on it),
`ink` (accent as text on a card), `accent2` (+42° hue, so the brand gradient is personal too).
Stops sit at equal cumulative OKLab distance with per-hue in-gamut chroma found by bisection, and
lightness following each hue's gamut cusp — which is what restores true yellow and true blue that
the rejected Uniform variant destroyed, and separates neighbours 1.6× better.

Consequences that must not be lost: `onFill` is **36 dark / 12 white**, per-stop and not one rule.
`ink` **differs from `fill` for 13 of 48**, so `--accent-ink` stays a required distinct token.
`--accent-strong` **loses its job** (with per-stop `onFill`, the fill _is_ the strong value).
`--on-accent` **stops being a constant** and becomes per-stop, so the adjacency discipline matters
_more_ — there are now 48 pairs. `--grad`'s decoration-only ban **stands** but becomes a per-stop
question. The picker becomes a **discrete 48-swatch grid**, because a colour _between_ two stops
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

| Stop    | vs real `--card` | vs mockup surface |
| ------- | ---------------- | ----------------- |
| Cobalt  | **4.473**        | 4.501             |
| Denim   | **4.477**        | 4.505             |
| Rose    | **4.477**        | 4.504             |
| Orchid  | **4.481**        | 4.509             |
| Magenta | **4.483**        | 4.510             |
| Fuchsia | **4.490**        | 4.517             |

The reported worst case was 4.50 — a margin of ~0.00 — so any surface drift at all was going to
cross it. **This is the same defect class as the `colors.test.ts` landmine**: a contrast measurement
bound to a duplicated surface value rather than to the token the app paints. The palette direction
is unaffected; the _numbers_ must be regenerated with the app's real surfaces as the input, and the
generator must read them rather than restate them.

### ⚠ Correction: the rendered-DOM prerequisite is two rungs, not one

Aliasing `$app`/`$env` in the preload was recorded as converting measured tap geometry, clipping,
computed contrast and safe-area violation to checkable. **The measurement half is false.**
happy-dom 20.14.0's `getBoundingClientRect()` is a stub — `Element.js:795`, `// TODO: Not full
implementation`, `return new DOMRect()`, all zeros — and it has **no layout engine**.

So: **rung M** (mount — cascade, computed declared values, effects; unblocked by the aliasing) and
**rung L** (layout — real headless Chromium, already in-repo at `tests/e2e/driver.mjs`). The four
measurement claims land on **rung L**. A plan that stops at rung M has made none of them checkable.

### Superseded: four "not decided" items were already decided

The design handoff listed these as open. They are not, and the mechanism in each case already
ships:

- **A host concept exists**, centralised in `server/capabilities.ts` as `can(actor, cap)`,
  carrying the owner's dated ruling: _"Today every joined singer is a host. That is Angelo's call
  (2026-09-04) … there is no operator to be, and inventing an admin password for a party is worse
  than the exposure."* Gating it later is an edit **there and nowhere else**.
- **Cross-singer reorder is expressed directly, and pinning is gone** — an earlier change step 3 deleted pinning
  outright: the `move-global` and `unpin` ops, the `pinnedSeq` column, and `rotation.ts:placePins`
  went with it. The queue is now a single stored ordered list and _is_ the source of truth, so a
  reorder rewrites that list in place and is durable by construction — there is nothing left to pin.
  `queue:reorder-any` survives as the capability gating a `move` on an entry the actor does not own.
  What remains is wiring the phone arrows and drag to one "move to index" op that rewrites the stored
  list: that is **an earlier change step 4**, not yet shipped.
- **A rate limit exists** — `MAX_CONCURRENT_PROCESSES_PER_SINGER = 3`, refused as `over-limit` and
  answered HTTP 429 with a phone-showable reason. The uncapped axis is **queue depth per singer**.
- **A lost optimistic race is already disclosed** — `hub.ts` emits `op:reject`, the queue store
  rolls back to the pre-op snapshot, and it surfaces as a `role="alert"` toast.

What remains open in all four is **policy content, not mechanism** — much cheaper than the handoff
assumed. Those are the named-decision rows in [`ux/05-concurrency.md`](ux/05-concurrency.md).

---

## Ratified: what a guard may couple to (decided 2026-09-11, after the the shadcn migration remediation)

**Audience: anyone writing or reviewing a guard in this repo.** These five rules come out of fixing
the post-the shadcn migration UI defects, and each one is stated because a guard that broke it either _let a real
defect ship_ or _blocked the correct fix_. They are not style preferences — every one has a measured
consequence below.

They are written to outlive any particular suite. A test-suite refactor was in flight when this was
ratified, so where a file or line count is quoted it is a snapshot taken on the the shadcn migration remediation
branch; if the number has moved, the rule still stands and the number is just evidence of how it was
found. Treat these as requirements on new guards, and as the review checklist for existing ones.

The single sentence they all reduce to: **a test may couple to a contract, never to an implementation
detail.** A class name, a source string, a current count, and a vendored file's internals are all
implementation details.

### 1. Never key a test on a styling class

**Measured state:** 81 of 93 `SEL` entries in `e2e/contract.ts` are class-based; only 6 use
`data-*` / `role` / `aria`. A further ~11 source-scan assertions pin `class="…"` literals directly
(`class="bar"`, `class="stage"`, `class="t"`, `class="jt-url"`, …).

**What it cost.** `LyricsReselect` shipped `<button class="chip">` when the only rule in the tree was
`.chip.ghost`, so the confirm button rendered as ~21px native OS chrome on a dark sheet. The class
survived with no rule _because a test was holding it up_ —
`lyrics-reselect-640.test.ts` selected `.reselect-acts .chip:not(.ghost)`, so `.chip` looked load-bearing
while styling nothing. Separately, `failed-process-turn-741.test.ts` requires the literal
`<button class="sing"` and `spotify-affordance-742.test.ts` requires `class="add"`, which is why
SongRow's two action buttons **could not** be migrated to the shared `Button` at all: a `class:`
directive is not valid on a component, so the guard and the refactor are mutually exclusive.

**The rule.** Address a control by what it does or what a user perceives. Best to worst:

1. accessible role + name — `getByRole('button', { name: /make karaoke/ })`
2. an explicit action hook — `[data-act="confirm-delete"]`
3. `data-testid`
4. **never** a class that also carries styling

Prefer (1) where the harness allows: it cannot rot without a real a11y regression, so the test and the
user experience fail together. Worked examples on the remediation branch: `routes/admin/+page.svelte`
(`data-act="arm-delete"` / `"confirm-delete"`, with per-song `aria-label`s) and
`lib/components/LyricsReselect.svelte` (`data-act="confirm"`).

**Ratchet, not a big bang.** Do NOT convert all 81 entries in one PR — a huge diff with no behaviour
change is expensive to review for zero user value. Convert an entry when you touch its control, and
pin the direction so it can only improve:

```ts
// contract.test.ts — new SEL entries may not be class-only
expect(classOnlyEntries.length).toBeLessThanOrEqual(81); // ratchet: never grows
```

### 2. A guard asserts rendered behaviour or a declared contract — not source text

**What it cost.** `stage-scale.test.ts` records the failure mode in its own comments: a _presence_
scan cannot see a loosened **value**, and `max-height: 14vh → 999vh` stayed green. Source scans also
produce false confidence in the other direction — `touch-targets.test.ts` passed for a build in which
the rule it read compiled to `.encore-slider.svelte-<hash>`, matching nothing, because the root was a
Bits UI component and Svelte put the hash on no element. The 28px thumb overflowed every settings
slider and a screenshot found it, not the suite.

**The rule.** Geometry, contrast and layout claims belong in the real-Chromium register that already
exists (`e2e/gates/measured-design.mjs` + `measured-design-register.mjs`, `bun run gate:measured`).
Do not build a second test stack for this — migrate claims into that register and shrink the
source-scan guards to _structural_ facts (a prop exists, a token is referenced, an element is a
sibling rather than a descendant). Where a rendered measurement is genuinely unavailable, say so in
the test rather than substituting a regex that looks equivalent.

### 3. A non-vacuity floor asserts that a subject EXISTS — never how many

**What it cost.** `design-system.test.ts` guarded the singer identity dot with `seen >= 2`, counting
`.who i` rules. The dot existed as four byte-identical copies; collapsing them into one shared
`.singer-dot` rule — **the correct refactor** — took the count to 0 and red the guard. A floor that
punishes deduplication is inverted, and deduplication is a stated goal.

**The rule.** A floor exists to catch _"the scan found nothing, so it passed blindly"_. So assert
`>= 1` subject and let the offence list carry the invariant:

```ts
expect(dotRules.length).toBeGreaterThanOrEqual(1); // it is declared SOMEWHERE
expect(offenders).toEqual([]); // and every declaration satisfies the rule
```

Scope floors (`filesScanned >= 30`) are legitimate and different — they pin the _population walked_,
which must not silently shrink. Occurrence floors on a pattern you might legitimately dedupe are the
ones to avoid. `non-vacuity-floors.test.ts` currently holds 56 floors; the ones with `min: 10 / 15 /
20 / 30` are worth auditing against this distinction.

### 4. Vendored components are wrapped, never edited

**Measured state:** 61 vendored `.svelte` files, of which **42 differ from the registry** and only
**19 carry an `ENCORE DEVIATION` header**. `ui/README.md` claims every deviation is enforced by a
named test; no test references the header at all.

**What it cost.** `shadcn-svelte add --overwrite` silently reverts 42 files with a green suite. The
sharpest single loss is functional rather than visual: `button.svelte`'s `touch-action: none` is what
makes the drag-reorder's `pointerdown` fire, and a re-pull drops it. Two latent defects also came from
editing rather than wrapping — `item-title.svelte` shipped `line-clamp-1` **and** `flex`, and in the
built bundle `.flex{display:flex}` is emitted at byte 3363 after `.line-clamp-1` at 3117, so the clamp
never applied; `field-label.svelte`'s hand-added `:global` margin is the only thing separating 50
controls on `/settings`, two files away from the page it rescues.

**The rule.** Keep `lib/components/ui/**` pristine and put Encore's choices in a wrapper one layer up:

```
lib/components/ui/button/button.svelte   ← PRISTINE, re-pullable forever
lib/ui/ActionButton.svelte               ← Encore's action vocabulary, built ON Button
```

A wrapper also solves the `class:` problem from §1: it takes `retry` as a **prop** and computes the
class internally, so the control can be a component and still express its states. Product semantics —
"accent means this processes for a minute, green means queue it now" — belong in the app's own
component, never as single-use variants inside a shared primitive.

**Land the header guard regardless of §4's progress**: while any vendored file is edited, a test must
assert it carries a deviation header naming what a re-pull would lose. That is ~1 hour of work and it
converts `--overwrite` from a landmine into a decision.

### 5. Adopt a library's composition model, or do not adopt the library

**What it cost.** `/settings` uses `Field.Label` 27× and `Field.Description` 23× with **zero**
`Field` / `Field.Group` / `Field.Set`. shadcn puts the gap on the wrapper (`Field` is `gap-3`,
`Field.Group` is `gap-7`) and ships marginless leaves, so on registry CSS that stacks 50 controls
flush. It only rendered because the missing rhythm was hand-patched into the leaf components. 61 leaf
call sites remain tree-wide.

**The rule.** Use the parts as composed, or use none of them. Cherry-picking leaves gives you the
library's structure _and_ the maintenance of its spacing.

The corollary is that a primitive is not chosen by its NAME. `Item.Group` is a vertical stack; the
`/metrics` `.kv` strip is a four-cell horizontal comparison grid, so adopting it would have stacked the
cells into rows — and under `source(none)` a className passed into a component mints nothing, so it
cannot be overridden back. Three separate callers correctly refused `Item.Description` for the same
reason: its `line-clamp-2` is live, and the clamped line was load-bearing copy
(`MyPositionCard`'s position sentence, `JoinLanding`'s SC 3.3.8 scan instruction).

### Two invariants that must survive any suite rewrite

Both shipped past a fully green suite, and both are mutation-proven on the the shadcn migration remediation branch as
`lib/class-reachable-alone-913.test.ts` and `lib/field-rhythm-913.test.ts`. The FILES are disposable;
the invariants are not. If a suite refactor lands first and these two files rebase away, re-derive them
in whatever shape the new suite uses — and re-run the mutations, because both of these guards had bugs
that only a mutation caught (one passed by never running).

1. **An element's class list must be matchable by some rule.** For class list `L`, some selector must
   contain a compound whose class-set is a SUBSET of `L`. `.chip.ghost` requires `{chip, ghost}`, which
   is not a subset of `{chip}` — the defect. Note the naive phrasing ("every class written alone must
   be reachable alone") is WRONG and produces false positives on the ordinary modifier idiom
   (`class="stage bad"` with `.stage.bad`, plus four others) — the element is styled because it also
   carries a base class that has its own rule.
2. **A marginless primitive leaf must have something that spaces it** — a wrapper, a local gap, or a
   recorded substitute. Absence of a construct is invisible to a scan looking for what IS written,
   which is exactly why the `/settings` collapse shipped.

### Not decided here

**Preflight.** Currently off, which forces every vendored component to assume a reset it does not get
(one live consequence found and fixed: no form control inherited the app font). Enabling it owes the
evidence bar recorded at `lib/tailwind-toolchain.test.ts` — 9,892 computed-value changes / 2,696 moved
boxes. Half-off is the expensive state, but nothing above is blocked by resolving it.

---

## Deferred — do NOT pick these up

Parked deliberately. These return only if the owner says so.

- **Audio-REACTIVE visualizers** — the time-driven ones shipped; making them respond to the sound did
  not. What shipped: four renderers (plasma, starfield, ripples, phase curves) as pure functions of `t`,
  selectable per room. What is still parked, and why each was designed _around_ rather than solved:
  - _Real FFT._ Still needs an `AudioContext` on the TV. `/tv` has no gesture handler, but `TvPlayer`
    also swallows its autoplay rejection, so the app _already_ depends on the TV permitting unmuted
    autoplay — an `AudioContext` is the same bet, not a new one. The real work is the graph: one
    `MediaElementAudioSourceNode` per `<video>` (two slots, each recreated when its `{#if}` toggles),
    following whichever slot is audible across a gapless swap, and reaching `ctx.destination` or **the
    song goes silent**. See HANDOFF gotcha 18.
  - _`bars` and `scope`._ Deliberately absent from `TV_VISUALIZERS`, and a test pins the exclusion by
    id. They assert they are drawing the signal; nothing reads it. They arrive **with** real analysis or
    not at all — and that test is the thing to delete, on purpose, in the commit that adds it.
  - _Score-reactive modulation._ Has no data to react to at all: scoring was REMOVED outright.
  - _Visualizers on the no-lyrics screens_ (lobby, `waiting`, interstitial). The ratified band for
    backgrounds is playing-only; extending it is a separate decision.
  One incidental note that is load-bearing for any FFT work: it is possible at all only because
  `TvPlayer.fileSrc` hardcodes `/media/${ref}`, so the media element is always same-origin. A
  cross-origin source taints `MediaElementAudioSourceNode` and every FFT visualizer silently goes flat
  with no error. This is no longer merely incidental: the `MediaStore.url()` presign path that could have
  made the element cross-origin was **deleted** (it had no production caller — `docs/arch/01-media.md`
  `XR-MED-10`), so same-origin playback is now a structural property of the store interface, guarded by
  `tests/guards/subsystem-media/store-members-have-production-callers.test.ts`. Reinstating a URL-returning
  store member is a decision about *this* deferred work, and must be argued here.
- **Milkdrop-class WebGL preset rendering.** A hand-rolled fragment shader if ever, not `butterchurn`:
  this project vendored Lucide _path geometry_ rather than accept a webfont, to stay offline-LAN-safe.
- **Human lyrics review UI** (idea from `karaoke-gen`). Provenance _labelling_ shipped; review is the
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

## Ratified: the phone remote is rebuilt around a drawer (decided 2026-09-14)

The phone remote is being rebuilt: the queue becomes the whole home screen, the now-playing hero card
goes, and one **band** — persistent app chrome in `routes/+layout.svelte`, not a home-screen element —
carries the peek and pulls up into a **drawer** holding the transport plus the live controls. Search
turns that same band into the field, and its zero-query state is the library.

**The drawer is shadcn-svelte's `drawer`, and `vaul-svelte` is a pinned exact dependency
(`1.0.0-next.7`).** The owner ruled against hand-rolling it and against vendoring vaul's source. Three
consequences were accepted knowingly, each measured rather than assumed:

1. **The gate leg is now `bun run test`, not `bun test`.** `vaul-svelte` declares
   `exports["."] = { types, svelte }` with **no `default`, no `import`, no `require`**. Vite applies the
   `svelte` condition so the app builds; bun's test resolver does not, so a bare `bun test` fails with
   `Cannot find package 'vaul-svelte'` **while the build stays green** — and `mount-rung.test.ts` imports
   every component that imports a `$app/*` module, so the phone surface would have gone dark silently.
   The fix is `--conditions=svelte`, declared **once** inside package.json's `test` script so no
   contributor has to know the flag exists. It cannot live in `bunfig.toml`: a `conditions` key was
   measured as ignored on bun 1.3.14 both at top level and under `[test]`.
2. **`drawer-surface-removed-903.test.ts` is deleted.** It asserted `vaul-svelte` absent and both old
   sheet components gone from disk — the negation of this design. A whole deleted guard file gets **no**
   `RETIRED` entry (`non-vacuity-floors.test.ts`'s own retirement arm rejects a key that no longer
   resolves), so the record is this section plus the deleting commit. Its `scanned` floor and tagged
   site went with it: `located` and `taggedSitesSeen` moved 73 → 72 in lockstep, as their comments
   require. What covers the survivors is strictly more than that file held — see below.
3. **Upstream is frozen.** `1.0.0-next.7` published 2025-03-24 and is still the newest; the `latest`
   tag points at `0.3.2`, which depends on `bits-ui@^0.21.7` and would install a **second, ancient
   bits-ui** beside ours. Pin the prerelease exactly; do not float it.

**The copy-in shipped two real defects, both caught by existing guards rather than by review.** This is
the copy-in rationale earning its keep, and worth recording because the next `--overwrite` reintroduces
both:

- `drawer-content.svelte` arrived with `sm:max-w-sm`. This app bridges t-shirt **spacing** keys and does
  **not** bridge the container scale, so `max-w-sm` resolved `sm` through the wrong namespace and emitted
  `max-width: 8px`. Now `max-w-[24rem]`. Caught by `vendored-dimension-keys.test.ts`.
- `drawer-overlay.svelte` arrived with `data-open:animate-in data-open:fade-in-0
  data-closed:animate-out data-closed:fade-out-0`. `motion.test.ts` rejects `animate-*` **outright**,
  which is the rule working as designed: a utility-expressed animation is invisible to the declaration
  scans by construction, which is the enforcement gap `XR-PH-06` exists to close. The fade is now a
  scannable declaration in that component's own `<style>` — opacity only, duration from `--motion-base`,
  gated on `prefers-reduced-motion`, addressed via `:global([data-slot='drawer-overlay'])` because a
  class string handed to a component carries no scope hash.

It also arrived with `max-h-[80vh]`, corrected to **`max-h-[82dvh]`** — iOS resolves `vh` against the
LARGE viewport, so a `vh`-capped sheet hides its own footer while the URL bar shows. That correction
restores the **successor address** the retired dvh sheet-cap scan recorded as missing, so that rule can
be re-anchored against one live subject instead of a deleted two-file list.

**What did not change:** the band contract (`--dock-h` equals the band's real rendered height, with the
safe-area inset on the band alone and nothing above it adding a second `env()`) survives in
`phone-home-shell-832.test.ts` and in the rung-L measured gate. `XR-PH-15` still holds — the guide
level, pitch and range bar sit in a disclosure **body** and never on a drag surface — but the container
it names is now the drawer rather than the hero, and the range bar sits directly under the key control
so the ± buttons and their consequence are adjacent.
