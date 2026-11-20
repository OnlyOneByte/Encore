# UI checklist: motion

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

| File                          | For          | What it is                                                                                                           |
| ----------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `clip.gif`, `clip-slow4x.gif` | the owner    | Real speed and 4× slow. The before and settled frames are each held 700 ms.                                          |
| `filmstrip.png`               | the reviewer | Every frame, labelled with its exact animation time in ms.                                                           |
| `filmstrip-reduced.png`       | the reviewer | The same trigger under `prefers-reduced-motion: reduce`.                                                             |
| `metrics.json`                | both         | Declared duration, easing and properties; rAF cadence, dropped frames, long frames, CLS; the reduced-motion verdict. |

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

## The checks

Answer each from `filmstrip.png`, `metrics.json` and the diff. A PR says which passed, as "checklist 10/10".

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
   noise. A row with a TV playing in the same browser (`phone-on-deck-heads-up`) is the noisiest. These are headless
   numbers (see Limits), so compare them, never quote them as a phone's.
10. **It is readable.** `clip.gif` is at most 1.5 MB and 4 s; `filmstrip.png` is at most 2000 px a side (crop with
    `stripClip`, shrink with `scale`).

## Putting the GIF in the PR

`gh` cannot attach images to a PR. The media goes on the `ui-review-media` branch instead, which shares no
history with `main`, and a PR comment links it. GitHub renders a `github.com/<repo>/blob/<branch>/<path>?raw=true`
link as an inline image. For a private repo, the link works only for someone signed in who can read the repo,
and anyone else gets a 404. No service or secret is involved.

```sh
bun run ui:review:publish-media -- 973                        # every row in .artifacts/motion, as pr-973/after/
bun run ui:review:publish-media -- 973 --dir before --slow phone-leave-dialog
```

Per row it publishes `clip.gif` (or `clip-slow4x.gif` with `--slow`), `filmstrip.png` and `metrics.json`, and
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
