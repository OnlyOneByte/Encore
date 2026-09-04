# SPEC — lyrics TEXT settings (size, font, case, lines before/after)

Four more room-scoped settings on the TV lyrics reel: **text size**, **font**, **case**, and
**how many lines show before and after** the current one.

Worktree `/local/home/angryang/.kiro/crew/workspace/encore-lyrics-text`, branch
`feat/lyrics-text-settings`, off `30b8b6d` (PR #10 merged).

## First: this reverses a call I made in PR #10

PR #10's spec said, in as many words, that reel geometry / font size / row count were **out of
scope** because PR #8 had solved them with a distance-based scale, and that "re-exposing them as room
settings would let a party undo a legibility fix."

That reasoning was about *raw* values, and it still holds for raw values. So this feature does not
simply expose what #8 computed — it exposes a **bounded adjustment on top of it**, which is a
different thing. Where the two collide, the legibility floor wins. Called out per option below.

## What is actually there today

`apps/core/src/lib/tv/LyricsOverlay.svelte`:

| Thing | Today | Note |
|---|---|---|
| Text size | `.viewport { font-size: clamp(3.1rem, 6.4vh, 6rem) }` | distance-based, from PR #8 |
| Font | inherited — `app.css:126` system stack, **no bundled font files** | |
| Case | none (`text-transform` only on `.notice`) | |
| Rows | `height: 9.5em` = 5 rows × `line-height: 1.9` | 2 before + current + 2 after |
| Mask | gradient stops at 13% / 32% / 68% / 87% | **tuned for exactly 5 rows** |
| Centring | `reelOffset = -(row.offsetTop + row.offsetHeight/2 - viewport.clientHeight/2)` | measured, not computed |

## Design, per setting

### 1. Text size — a MULTIPLIER, never a pixel value

```css
font-size: calc(clamp(3.1rem, 6.4vh, 6rem) * var(--lyrics-scale, 1));
```

Storing a px size would throw away the `vh` term, so the same room would render wrong the moment the
TV resolution changed — which is exactly the regression #8 fixed. A multiplier keeps the adaptive
scale and layers a room preference on it.

`lyricsScalePct`, an integer percent, clamped **80–160**. Integer because `RoomSettings` is persisted
in SQLite and every other numeric there is an integer; a float column for one field is not worth it.
The 80 floor is the legibility guard — it is deliberately not lower.

### 2. Font — a registry of LOCALLY AVAILABLE stacks

Hard constraint: **no webfont, no CDN.** The icon system was deliberately built by vendoring path
geometry for exactly this reason (offline LAN), and this deployment has already produced a tofu box
where a glyph was missing. So a font setting cannot fetch anything, and every option must degrade to
a generic family rather than to tofu.

```ts
export const LYRICS_FONTS = [
  { id: 'system',  label: 'System',        stack: 'inherit',                    note: 'Whatever the TV browser uses for the rest of the app. Always available.' },
  { id: 'grotesk', label: 'Wide sans',     stack: "'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif", note: 'Slightly wider letterforms. Reads well at distance.' },
  { id: 'serif',   label: 'Serif',         stack: "Georgia, 'Times New Roman', serif", note: 'Higher contrast strokes. Some rooms find it easier on a bright screen.' },
  { id: 'mono',    label: 'Monospace',     stack: "ui-monospace, 'Courier New', monospace", note: 'Even letter widths, so the line does not reflow as words light up.' }
] as const;
```

Four is the honest ceiling: anything beyond this needs a font the box does not have. `system` stays
the default so nothing changes for an existing room.

### 3. Case

`lyricsCase`: `natural` (default) | `upper` | `lower`, applied as `text-transform`.

`text-transform` is presentation-only — it does not change the DOM text — so the per-word spans, the
marker and the highlight are all unaffected. Two things the notes must say out loud rather than
pretend away:

- **Upper** measurably slows reading of running text (no ascender/descender silhouette) and widens
  every line, so more lyrics wrap. Offer it, label the cost.
- **Lower** destroys proper nouns and the pronoun "I". For song lyrics that is a real content loss,
  not a style choice.

Both interact with wrapping, which changes row height — already handled, because PR #8's
`ResizeObserver` re-measures the reel on any size change.

### 4. Lines before / after — the one non-trivial piece

This is **not** just a height change, and it is the part worth reading carefully.

The reel **centres** the current row in the viewport. Equal rows above and below is therefore a
geometric consequence, not a setting: with the current row centred you *cannot* show 1 before and 3
after, no matter what height you pick. Asymmetry needs the offset itself to be biased:

```ts
// Bias the centre point by half the difference, in rows, so the current line sits
// above centre when more lines are wanted after it.
const bias = ((after - before) / 2) * rowHeight;
reelOffset = -(row.offsetTop + row.offsetHeight / 2 - viewportEl.clientHeight / 2 - bias);
```

Two more couplings that must move with it, or the feature looks broken:

- **Viewport height** stops being a constant: `height: calc((before + 1 + after) * 1.9em)`.
- **The mask gradient is tuned for 5 rows.** At 3 rows the 13%/87% fade stops eat into the current
  line; at 7 rows they barely fade at all. Switch the stops from percentages to `em` offsets
  (roughly one row's worth at each edge) so the fade stays one row deep regardless of count.

Ranges: `lyricsLinesBefore` **0–3**, `lyricsLinesAfter` **0–4**, defaults 2 and 2. Capped because
the reel is a fixed fraction of the screen — at 9 rows the type has to shrink to fit and the
distance-legibility work is undone by the back door.

## Explicitly NOT included

- **`line-height`.** It looks like a natural sibling and it is a trap. The marker is absolutely
  positioned above its word, and the existing comment records that at tight leading the dot lands on
  the *previous wrapped line*. Exposing leading would let a room silently break the ball.
- **Text colour.** The highlight already owns colour meaning (dim / accent / white), and the score
  badge owns the other bands. A free colour collides with both.
- **Font weight.** Low value next to size, and it changes wrapping. Say the word if you want it and
  it is one more registry field.

## Contract

```ts
interface RoomSettings {
  // …existing six…
  lyricsScalePct: number;        // 80–160, default 100
  lyricsFont: LyricsFontId;      // default 'system'
  lyricsCase: LyricsCaseId;      // default 'natural'
  lyricsLinesBefore: number;     // 0–3, default 2
  lyricsLinesAfter: number;      // 0–4, default 2
}
```

Every default reproduces today's TV exactly, test-pinned, so the migration is invisible.

**These do NOT go through `resolveLyricsPresentation`.** That resolver exists to apply the
downward-only clamp against the global `syncMode` granularity. Size, font, case and row counts do not
depend on timing at all, so routing them through it by pattern-match would dilute what `clamped`
means. They are read straight off `settings.room` and passed as props. Worth stating because the
next person will be tempted.

## Commits

1. **shared** — `LYRICS_FONTS` / case registries in `lyrics-engines.ts`, five `RoomSettings` fields,
   `normalizeRoomSettings` branches (clamp numerics, per-field fallback to current), tests.
2. **db** — additive migration `0004`, repository read/write, round-trip tests.
3. **TV render** — the four CSS knobs as custom properties, the biased `measureReel`, the row-derived
   viewport height, the em-based mask; gallery cards covering the asymmetric and extreme-count cases.
4. **phone Settings** — five controls in the existing "Lyrics on the TV" block.

Verification: `bun test`, `bun run check`, then eyes-on frames — asymmetric counts and the 80/160
size extremes are the ones a still frame can actually prove, plus one wrapped-uppercase line to show
the re-measure holds.

## Built — and what measuring changed

All four commits landed. Three defects were caught by asserting the geometry against the DOM rather
than by looking at frames, and none of them would have failed a test:

1. **The bias sign was inverted.** Wanting more lines AFTER means the current line must sit HIGHER,
   so the term is `before - after`. The first version had it backwards and put the current line
   *below* centre for `linesBefore: 0`.
2. **The mask fade dimmed the words being sung.** One row deep at each edge is right until the current
   line IS the edge row — at `linesBefore: 0` the top fade landed on it. The edges are now separate
   variables and an edge with no context rows is not faded at all.
3. **The row-count gallery cards proved nothing at first.** They sat at 0.8s, which is line 0, where
   "2 lines before" has no lines to show. Moved to 9.5s (line 3 of 6), and onto a short-line doc,
   because the real demo lines wrap at gallery width and a doubled row height makes the count
   unreadable.

Final geometry, asserted numerically: viewport height equals `rows x rowHeight` in every case
(365=3x122, 608=5x122, 730=6x122, 973=8x122), and the current row's offset from centre is -1 row at
0-before/2-after, +1 at 2-before/0-after, -1.5 at 1/4, -0.5 at 3/4, 0 at the symmetric default.

**One thing the reel does that the setting cannot promise:** `.viewport` is a flex item, so it shrinks
rather than overflowing when the requested rows do not fit the screen. That is the right failure — a
reel taller than the TV would be worse — but it means a large row count on a short screen silently
delivers fewer rows than asked.

**Not verified end-to-end on the TV.** `/tv` on an empty room is the attract screen with no `.lyrics`
element, so there is nothing to inspect without a cooked song. The render path is covered by the
gallery, which drives the same component with the same props.
