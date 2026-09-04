# SPEC — lyrics presentation as room settings

Move the TV lyrics *presentation* choices — the bouncing ball and how words are highlighted — out of
hardcoded CSS in `LyricsOverlay.svelte` and into the **room** settings layer, alongside
`tvProgressStyle` and `interstitialMs`.

Rescoped against `f1e6afe` (PR #7 lyrics-timing + PR #8 ui/design-system). Both landed in the middle
of this and both moved the ground under the original draft.

## What changed, and what it costs this feature

**PR #7 added `packages/shared/src/lyrics-engines.ts`** — a `SYNC_MODES` registry, GLOBAL, with a
`granularity: 'word' | 'line'` field. That is now the single most important constraint on this
feature, because it means the word-vs-line distinction *already exists* one layer up. The spec below
is restructured around it rather than duplicating it.

**PR #8 shipped the TV type scale** (`--tv-label`/`--tv-body`/`--tv-name`/`--tv-hero` +
`--tv-safe-x/y` in `/local/home/angryang/.kiro/crew/workspace/encore-lyrics-style/apps/core/src/app.css`)
and already rewrote the parts of `LyricsOverlay.svelte` I had carved out of scope:

```
.viewport   font-size: 3.1rem              →  clamp(3.1rem, 6.4vh, 6rem)
.notice     font-size: 1.15rem             →  var(--tv-label)
.row        color: rgba(255,255,255,0.34)   →  0.62  "upcoming — must be READ, not merely sensed"
.word       color: rgba(255,255,255,0.4)    →  0.66
```

Two consequences. The collision risk I flagged is **gone** — that branch merged, so this one is the
only thing editing the file. And the dim states are now genuinely legible (0.62/0.66 rather than
0.34/0.40), which is what makes a *no-highlight* mode a real option instead of a useless one.

## The design, restructured: production vs presentation

The axis that matters is **who decides, and what they are deciding**:

| Layer | Setting | Decides | Why that scope |
|---|---|---|---|
| GLOBAL | `syncMode` | whether word timings **exist** | needs a worker that can load wav2vec2 |
| ROOM | `lyricsHighlight` | how existing timings are **drawn** | a staging choice for one screen |

These are not the same setting and must not be collapsed, but they are **coupled in one direction**:
a room can only ever render at or below the granularity the global mode produced. `syncMode: 'lines'`
means there are no word timings on disk, so a room asking for word-by-word is asking for data that
does not exist.

That is exactly the shape of `maxQualityRank`, which is already in `RoomSettings` as a downward-only
ceiling with the reasoning written out. **Reuse that pattern rather than inventing a new one.** The
room's choice is clamped by global capability; it can lower, never raise.

The honest distinction to hold in the copy:

- global `lines` = *don't pay for the aligner.* A cook finishes sooner. Nothing can follow words.
- room `line` = *the aligner ran, but this screen shows line-level.* The word data is on disk and a
  different room (or the same room later) can still use it.

### Registries

Follow the house pattern — the one `separators.ts`, `fetchers.ts` and now `lyrics-engines.ts` all
share: a registry with a label and a stated tradeoff, never a bare union.

```ts
export const LYRICS_BALL_STYLES = [
  { id: 'bounce',    label: 'Bouncing ball',  needsWords: true,  note: 'A dot above the word, bouncing. The classic.' },
  { id: 'steady',    label: 'Steady dot',     needsWords: true,  note: 'Same dot, no bounce. Calmer on a big screen.' },
  { id: 'underline', label: 'Underline',      needsWords: true,  note: 'A bar under the word being sung.' },
  { id: 'off',       label: 'No marker',      needsWords: false, note: 'Colour alone shows the word. Least busy.' }
] as const;

export const LYRICS_HIGHLIGHT_STYLES = [
  { id: 'word', label: 'Word by word',   granularity: 'word', note: 'Each word turns pink as it comes.' },
  { id: 'line', label: 'Whole line',     granularity: 'line', note: 'Lights the current line only. Best when word timing is patchy.' },
  { id: 'off',  label: 'Just the words', granularity: 'line', note: 'No highlight — the scrolling reel alone. Plain read-along.' }
] as const;
```

`needsWords` and `granularity` are not decoration — they are what the clamp reads. Any option that
needs word timings is unreachable under `syncMode: 'lines'`, and the resolver degrades it rather than
rendering an empty ball.

**`fill` is dropped from the registry.** The original draft floated re-litigating it as opt-in. PR #7
settled the argument from the other side: `SYNC_MODES` now states outright that forced alignment buys
"per-word highlighting and the bouncing ball" — word-level marks, not sub-word ones. A sweep across a
word still animates detail no aligner produced, and the existing comment in `LyricsOverlay.svelte`
("a lie dressed as precision") remains correct. Not worth the code.

### The line path already exists

`LyricsOverlay.svelte` renders `{#if i === lineIdx && l.words.length}` and falls through to
`{l.text}`. Line-level rendering is already a live, data-driven fallback — the room setting reuses
that branch instead of adding a renderer. This is why the feature stays small.

### Contract

```ts
interface RoomSettings {
  tvProgressStyle: TvProgressStyle;
  interstitialMs: number;
  maxQualityRank: number | null;
  lyricsBall: LyricsBallStyle;        // default 'bounce'  — today's behaviour
  lyricsHighlight: LyricsHighlight;   // default 'word'    — today's behaviour
  lyricsLeadMs: number;               // default 300       — today's LYRICS_LEAD_SEC
}
```

Plus one resolver in `@encore/shared`, mirroring `resolveCookSeparator`:

```ts
resolveLyricsPresentation(settings: EffectiveSettings): {
  ball: LyricsBallStyle; highlight: LyricsHighlight; leadSec: number
}
```

It clamps the room's request to what global `syncMode.granularity` can satisfy. One pure function,
one test table, and the TV renders whatever comes back without re-deriving the rule.

### Lead nudge

`lyricsLeadMs`, clamped 0–1500, default `300`. Wires the `leadSec` prop that already exists on the
component and that nothing currently sets. `lyrics.ts` already argues for this scope in a comment:
"a presentation preference that can be retuned per room without recomputing anything."

Composes with, not replaces, any per-song measured offset from `fit_lrc_to_aligned` — the fitted
offset corrects *that recording*, this corrects *this room's screen and this crowd's reaction time*.

## Still out of scope

Reel geometry, font size, row count, mask. Not for collision reasons any more — PR #8 did that work.
They are now *solved* with a distance-based scale, and re-exposing them as room settings would let a
party undo a legibility fix. Use `--tv-*`; do not make them settings.

Also out: per-singer overrides. A room has one TV.

## Commits

1. **shared** — `LYRICS_BALL_STYLES` + `LYRICS_HIGHLIGHT_STYLES` (in `lyrics-engines.ts`, next to
   `SYNC_MODES`, since the clamp couples them), 3 `RoomSettings` fields, `normalizeRoomSettings`
   branches, `resolveLyricsPresentation` + its clamp table. Tests alongside the existing
   `separators.test.ts` room-layer cases.
2. **db + repository** — additive migration (3 columns, defaults = today), `getRoom`/`setRoom` read
   and write them, cases in `settings-repository.test.ts`.
3. **TV render** — `LyricsOverlay` takes `ball`/`highlight`/`leadSec`; `tv/+page.svelte` calls the
   resolver and holds `room` as one object instead of copying field-by-field into locals inside the
   `settings:changed` branch (adding three more that way is six lines that can drift). Variants added
   to the `/components` gallery.
4. **phone Settings** — three controls in the existing "This room" section, notes from the registry.
   Where a choice is clamped by the global `syncMode`, **say so inline** rather than silently showing
   a picker whose value will not be honoured.

Verification: `bun test`, `bun run check`, then eyes-on frames of each variant from `/components`.
Note PR #8 also rebuilt `e2e/party.mjs` and wired selector rot into CI — check it still passes rather
than assuming the old "not a declared dep" caveat holds.

## Shipped

All four commits are in, verified, and the `fill` mode was dropped as argued above.

An `'auto'` mode — degrade word→line **per song** on the timing validator's coverage — was
considered and **deferred, because it is not a settings feature at all**. `validate_timing` in
`apps/worker/src/lyrics_validate.py` computes coverage, `long_gaps` and `smeared`, but `whisperx.py`
only `print()`s the report: the worker acts on `usable` alone and discards the rest, and `coverage`
appears nowhere in `apps/core/src` or `packages/shared/src`. So auto mode needs a data path first —
report fields on the align-complete message, somewhere to persist them per media, and shipping them
to the TV — which is its own larger feature.

There is also a design argument against it that the source already makes: the comment at
`whisperx.py:455` states thin coverage is "usually CORRECT — an instrumental break or outro genuinely
has no words" and is "a prompt to look, not a diagnosis". Auto mode would turn that signal into an
automatic behaviour change, degrading a whole song's highlighting because its outro is instrumental.
If per-song adaptation is wanted later, start by persisting the timing report — which also buys a
visible record of which cooks came out badly, more useful than silent degradation.
