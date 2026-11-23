# UI checklist

A UI PR's reviewer checks it against this list. It has two parts: the [motion checks](#motion-checks), answered
from the frames `bun run ui:review` records, and the [tenet checks](#tenet-checks), which hold a change to the
[UI tenets](UI-TENETS.md): speed, stillness, one glance, one truth, the TV stage, fun and access. A PR answers the
sections it touches and says which lines passed, as "Motion 11/11, Speed 4/4". The [docs check](#docs) applies to
every PR, UI or not.

A static screenshot cannot see motion. The leave confirm drew itself half its own size up and to the left for its
whole 120 ms opening and then snapped to the centre (#964). CLS was 0, no frame dropped, and reduced motion hid it.
Only the frames showed it. So a UI PR that adds or changes motion shows its frames, and its reviewer checks them
against this list.

## Run it

Needs, from `core/`: `bun install`, `bun run build`, a Chromium for Playwright (`bunx playwright install chromium`,
or `PW_CHROMIUM` pointing at one; see [E2E.md](E2E.md#chromium-discovery)), and ffmpeg on `PATH` or in `FFMPEG_BIN`
for the rows that seed songs (`phone-on-deck-heads-up`, `tv-song-intro`). Without ffmpeg those two fail with "the
seeded library never indexed a local track". The GIF and PNG encoding is pure JS and needs nothing else.

```sh
cd core && bun run build
bun run ui:review                          # every row
bun run ui:review -- -g phone-leave-dialog # one row
```

Each row of `tests/playwright/specs/shot/motion.spec.ts` writes `tests/playwright/.artifacts/motion/<row>/`
(or `$MOTION_OUT/<row>/`). Playwright empties `.artifacts/` at the start of every run, so copy what you need
before running anything else, or set `MOTION_OUT`:

| File                                                   | For          | What it is                                                                                                                                                                                    |
| ------------------------------------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clip.gif`, `clip-slow4x.gif`                          | the owner    | Real speed and 4× slow. The before and settled frames are each held 700 ms.                                                                                                                   |
| `filmstrip.png`                                        | the reviewer | Every frame, labelled with its exact animation time in ms.                                                                                                                                    |
| `filmstrip-reduced.png`                                | the reviewer | The same trigger under `prefers-reduced-motion: reduce`.                                                                                                                                      |
| `metrics.json`                                         | both         | Declared duration, easing and properties; rAF cadence, dropped frames, long frames, CLS; the reduced-motion verdict.                                                                          |
| `realtime.gif`, `filmstrip-realtime.png` (and `-late`) | both         | A row with `realtime` only: what Chromium painted at 6× CPU throttle (and with its first frame 400 ms late), labelled in wall-clock ms, plus `metrics.realtime` and one printed line per run. |

A row about timing (a stream, a sequence, anything released on a clock) adds `realtime: { each, avoid,
lateFirstFrameMs, windowMs }`. The seek run cannot show a motion that starts late, because its clock starts when the
motion does (#1000). `overlap` counts frames where two visible `each` boxes, or an `each` and an `avoid` box,
intersect; `min gap` is the closest two `each` boxes came (negative is an overlap); `blank` counts holes in the stream;
`first frame` is the worst mount-to-first-frame time.

A new row is `{ name, what, open, trigger, only, stepMs }`: `open` gets a fresh page to just before the motion,
`trigger` fires it, `only` selects the subject so an unrelated fade is listed under `others` instead. Use
`stepMs` 33 for motion of 0.5 s or more and 12 for `--motion-fast`. Drive the product's own trigger, never a
hand-set class: a row that fakes the state change records a frame the product never shows. A row that needs a
longer song adds one to `LIBRARY` (the fixture's are 8 s), and `startFakeWorker(world, { seconds })` makes the
stems match. A row whose honest record is a cut goes in `CUTS`, and the PR that gives it motion takes it out. A
row with one deliberate literal names it in `literalsAllowed: { match, reason }`; that waives that one line only.

**What fails the run, beyond "no motion caught":** a caught animation whose duration, delay or animated colour is
authored as a literal instead of a `var()` token. Only the rules the browser applies during the capture are read:
a block under a media query or `@supports` that does not hold (a `reduce` override, a wide-screen variant) is
skipped. `metrics.json` records what the built CSS says for each one
(`declared[].source`), the strip's subtitle prints the verdict, and `tokens.problems` lists every literal.

## Motion checks

Answer each from `filmstrip.png`, `metrics.json` and the diff. A PR says which passed, as "Motion 11/11".

1. **Every frame is a plausible blend of its two ends.** Nothing is offset, clipped, flashing, blank or doubled.
2. **No jump at either end.** Compare `before` with `0 ms`, and the last frame with the settled state. Anything
   that changes at `0 ms` without being in `declared` is a jump, unless it is a content change that is meant to be
   instant (new text, a removed label) and the PR says so.
3. **The duration is a token in the source.** The CSS says `var(--motion-fast)`, `var(--motion-base)` or
   `var(--motion-slow)`, and has no literal delay either. **The tool checks this:** `declared[].source.duration` is
   the authored text from the built CSS (`durationMs` alone is the same 400 for a token and a literal `0.4s`), and
   any literal time left once the `var()`s are taken out (a duration or a delay; `0s` is fine) fails the run. A
   row's `literalsAllowed` can waive exactly one named literal, with a reason, and the source needs a comment at
   that literal too; any other literal on the row still fails. A motion timed by script (`element.animate`) is
   listed under `tokens.unchecked`: read its diff. Ease-out to enter, ease-in to leave.
4. **Reduced motion:** `reducedMotion.honoured` is true for the subject, and `reducedMotion.noVestibularMotion`
   is true for the page (a fade may stay, a slide or scale may not). The guard is the house
   `@media (prefers-reduced-motion: no-preference)` form, not an `animation: none` override.
5. **Only `transform` and `opacity` move things.** CLS is 0. A `properties` entry like `top`, `height` or
   `margin` is a red flag. (A colour fade is fine; it moves nothing.)
6. **An element placed with Tailwind `translate-*` animates `translate`/`scale`, never `transform`.** Tailwind v4's
   utilities set the `translate` property, so a keyframe `transform: translate(...)` applies the offset twice.
   This was the leave confirm bug.
7. **A comment that describes the motion matches the strip.** "Crossfade" must be a crossfade.
8. **No hard-coded durations or colours, and each keyframe is defined once.** Colours come from theme variables.
   **The tool checks the colours that animate** (a transition's end-state rules, an animation's keyframes) and fails
   the run on a literal such as `#ff2d95`. Colours that don't animate, and whether a keyframe that already exists
   (for example `app.css`'s `.pop-in`) is reused rather than copied into the component, are read from the diff.
9. **The live run did not get worse.** One run is noise (the on-deck row gave 4 to 12 dropped frames on identical
   code), so the live pass runs 3 times (`MOTION_LIVE_RUNS`) and records the **median and range** in
   `live.droppedFrames` and `live.longAnimationFrames` (each `{ median, min, max }`; no single-run value is kept). Run the row on `main` and on the branch,
   on the same box. A regression is the branch's **median above main's maximum**; anything inside main's range is
   noise. `droppedFrames` counts intervals over 1.5x the run's OWN median interval (`live.frameIntervalP50Ms`), so a
   tree that paints faster has a lower bar: when the two medians differ, judge by the absolute numbers,
   `live.frameIntervalP95Ms` and `live.longAnimationFrames` (#1060). A row with a TV playing in the same browser
   (`phone-on-deck-heads-up`) is the noisiest. These are headless
   numbers (see Limits), so compare them, never quote them as a phone's.
10. **It is readable.** `clip.gif` is at most 1.5 MB and 4 s; `filmstrip.png` is at most 2000 px a side (crop with
    `stripClip`, shrink with `scale`).
11. **A row about timing (a stream, a sequence, anything released on a clock) has `realtime`.** Its overlap is 0 and
    its blank count is 0 in both runs.

## Tenet checks

Each line holds one of the [UI tenets](UI-TENETS.md); the tenet says why. "Automated" names the gate or probe that
already checks the line; `gate:measured` CLAIM n is a spec in `core/tests/playwright/specs/gate/`. A line marked
**not automated yet** is the reviewer's to answer from the diff, the phone 390×844 and 320×568 frames and the TV
1920×1080 frame; a gate candidate is a line worth promoting to `gate` once it is stable.

### Speed (tenets 1 and 2)

- **S1.** Tap to first visible change is at most 100 ms, at CPU 1× and 4×, for every control the PR touches.
  **Automated** at 1× for Sing (+), the dock tabs, On deck's key and Try again (`gate:measured` CLAIM 10, the best
  of 5 taps). The 4× numbers are printed and attached to the run but **not gated**: on a shared, loaded box a
  throttled page swings 2–3× between runs, so they are checked on a quiet machine or by the reviewer's A/B run
  (main and branch, same box). A control the gate does not tap is the reviewer's.
- **S2.** The PR's moments stay inside the [speed budget](UI-TENETS.md#speed-budget). The rows marked gated in
  that table are **automated** (`gate:measured` CLAIM 9, 10 and 13). For any other row, measure on `main` and on
  the branch; a regression is the branch's median above `main`'s maximum (motion check 9's rule).
- **S3.** No spinner or skeleton is on screen for less than 300 ms: it is never painted, or it stays at least
  300 ms (`PENDING_GRACE_MS` is the pattern), and a wait past 3 s says so in words. **Automated** (`gate:measured`
  CLAIM 12) on cold loads, the Sing search and a slow or lost `/api/me` (words not before 3 s; the 4 s upper bound
  races, #1093, and is the reviewer's). Today's breaks are expected failures that a fix flips, one per cause:
  "Finding the room…" on the QR link (#1089), "Loading the queue…" on `/queue` (#1090), and on a Sing search **two**:
  the "Searching…" skeleton rows (#1091) and the search field's own "Searching" spinner (#1126).
- **S4.** A new or longer timer on a budget moment is in the [deliberate waits](UI-TENETS.md#deliberate-waits)
  table with the owner's ruling. Read from the diff.

### Stillness (tenet 3)

- **M1.** Nothing runs longer than `--motion-slow` (400 ms), and no content is held at opacity 0 for longer than
  `--motion-base` (250 ms), beyond the ruled exceptions in tenet 3. This tightens motion check 3. **Automated**
  for the phone's search, add, tab and On deck moments (`gate:measured` CLAIM 14, declared duration plus delay of
  every animation that runs; loops and the strip's `--motion-tick` progress fill are not motion). The `/queue` Now
  card's 500 ms `arrive` is an expected failure a fix flips (#1092). For other motion, read `metrics.json`'s
  `declared[].durationMs`.
- **M2.** CLS 0 on the cold loads and the phone moments above, counting **every** shift, the ones within 500 ms of
  the tap that caused them included (a tap does not license a jump). **Automated** (`gate:measured` CLAIM 11).
  Stepping the On deck key shifts the card today (`OnDeckCard.svelte`'s facts line and RangeBar's `left:`), an
  expected failure a fix flips (#1127). Other state changes
  are `dock-cls` and `queue-now-cls` (probes) and the reviewer's.

### Glance (tenet 4)

- **G1.** At 320×568 the screen's primary action lies between the header and the dock's top edge, or the page
  brings it there. Not automated yet; a gate candidate for `measured-hit-extents`.
- **G2.** At 320 px there is no horizontal overflow and no ellipsised ruled copy; ruled copy wraps to at most two
  lines with no orphaned last word. Overflow and ellipsis are gate candidates; orphans are a human check.
- **G3.** Guest words: no jargon, and at most 25 words above the fold on a guest screen, not counting song titles
  and names. The word limit is to be calibrated on `main` before it fails anything; the wording is a human check.

### Truth (tenet 5)

- **T1.** A live screen equals a reloaded one, and phone and TV agree within 1 s (the handoff within 1.5 s).
  Covered in part by the `fresh-pick-every-phone` and `handoff` probes.
- **T2.** Every failure state the PR touches shows a next action. Automated for the song-making failures
  (`p21-no-dead-ends`); a new failure state adds a case there.

### TV (tenet 6)

- **V1.** The TV type floor, the safe area and plain ASCII hold. **Automated** for the type floor (`gate:measured`
  CLAIM 5), the safe area at 1920×1080 in the empty room and during a song (CLAIM 15) and plain ASCII (the guard in
  `core/tests/unit/lib/tv/stage-words.test.ts`). A TV state CLAIM 15 does not reach (the handoff card, a failure
  notice) is checked from its 1920×1080 frame; the cheers lane is the `reactions-lane` probe.
- **V2.** One copy of each fact on the stage. A human check, from the 1920×1080 frame.

### Fun (tenet 7)

- **F1.** The PR says what each new motion tells the room. A human check.

### Access

- **A1.** Tap targets are at least 44 px, focus shows a ring of at least 2 px, and a live region is mounted before
  its text arrives. Automated for the tap floor and the ring (`gate:measured` CLAIM 1 and CLAIM 4); the live-region
  order is not automated yet and is a gate candidate.

## Docs

Every PR answers this section, UI or not, as "Docs 1/1".

- **D1.** The docs the PR makes stale are updated in the same PR, and no new comment runs past a one- or two-line
  _why_ or carries history ([CONTRIBUTING](CONTRIBUTING.md#comments)). A human check, from the diff.

## Putting the GIF in the PR

`gh` cannot attach images to a PR. The media goes on the `ui-review-media` branch instead, which shares no
history with `main`, and a PR comment links it. GitHub renders a `github.com/<repo>/blob/<branch>/<path>?raw=true`
link as an inline image. For a private repo, the link works only for someone signed in who can read the repo,
and anyone else gets a 404. No service or secret is involved.

```sh
bun run ui:review:publish-media -- 973                        # every row in .artifacts/motion, as pr-973/after/
bun run ui:review:publish-media -- 973 --dir before --slow phone-leave-dialog
bun run ui:review:publish-media -- 973 --realtime tv-reaction-lane   # a timing row: its real-time run instead
```

Per row it publishes `clip.gif` (or `clip-slow4x.gif` with `--slow`), `filmstrip.png` and `metrics.json`
(`--realtime` swaps in `realtime.gif` and `filmstrip-realtime.png`; `--realtime=late`, the late run's), and
prints the Markdown to paste into the comment. It refuses any GIF or strip over **1.5 MB**: two media files per row
keep a four-row PR to about 12 MB at most, and in practice 2 to 3 MB. It pushes without force, so two people
publishing at once cannot overwrite each other: the second push is refused, and running it again succeeds.

### Keeping the branch small

Deleting files on the branch does not shrink it: every old commit stays reachable, and so does every GIF in it.
So the branch is **re-rooted**: replaced by one new commit, with no parent, that holds only the media still
needed. Re-root it **when it passes about 200 MB, or once a quarter**, whichever comes first. The publish command
warns when it passes 200 MB.

```sh
bun run ui:review:prune-media -- --keep 973,980          # dry run: size now, what is kept, what is dropped
bun run ui:review:prune-media -- --keep 973,980 --apply  # re-root and force-push
```

`--keep 973,980`, `--keep 973 980` and `--keep=973,980` are the same. The command prints the keep list and refuses
to go on when an item is not a PR number, when a kept PR has no media on the branch (a typo), or when the list is
empty: dropping every PR's media takes an explicit `--keep-none`.

Keep the PRs that are still open. **Every dropped PR's media links then 404, for good**: a merged PR's GIFs are
history, and the strip that mattered was read in its review. The force-push is pinned to the tip the command read,
so a publish that lands in between is refused rather than lost; run it again. GitHub keeps unreachable objects
until its own garbage collection, but no clone or fetch receives them after the re-root.

### Not paying for it in every clone

A plain `git clone` and the default fetch refspec take every branch, this one included. To skip it:

```sh
git clone --single-branch --branch main git@github.com:OnlyOneByte/Encore.git    # a new clone
git config --add remote.origin.fetch '^refs/heads/ui-review-media'               # an existing clone (git 2.29+)
git branch -dr origin/ui-review-media                                            # and drop what it already has
```

The publish and prune commands never fetch the branch into the clone they run from: each works in a throwaway
clone of just that branch under the OS temp dir and deletes it at the end. An opted-out clone stays opted out.

## Limits

- **Headless numbers are not your TV.** The suite runs Chromium with `--disable-gpu`, so frame cadence and dropped
  frames are a floor on a dev box. Read them as regressions (check 9), not absolutes. A row with a TV playing in
  the same browser (`phone-on-deck-heads-up`) shows more long frames than one without. The seek frames are
  exact by construction.
- **Only seekable motion.** CSS animations and transitions and WAAPI (Svelte 5 transitions included) step
  exactly. A script tween (the lyrics reel), `<video>` and canvas do not.
- **Clock-driven rows pay their clock five times** (seek, three live runs, reduced). The TV attract phrase takes
  about 50 s and the on-deck crossing, which waits about 6 s of song per run, about 48 s; all four rows together
  take under a minute on 4 workers.
- **The trigger is a Playwright click**, so tap-to-first-frame latency on a real touch screen is not measured.
- **GIFs use a 256-colour palette per frame**, so the TV's gradients band slightly. The strips are lossless.
