# UI checklist: motion

A static screenshot cannot see motion. The leave confirm drew itself half its own size up and to the left for its
whole 120 ms opening and then snapped to the centre (#964). CLS was 0, no frame dropped, and reduced motion hid it.
Only the frames showed it. So a UI PR that adds or changes motion shows its frames, and its reviewer checks them
against this list.

## Run it

```sh
cd core && bun run build
bun run ui:review                          # every row
bun run ui:review -- -g phone-leave-dialog # one row
```

Each row of `tests/playwright/specs/shot/motion.spec.ts` writes `tests/playwright/.artifacts/motion/<row>/`
(or `$MOTION_OUT/<row>/`):

| File                          | For          | What it is                                                                                                           |
| ----------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| `clip.gif`, `clip-slow4x.gif` | the owner    | Real speed and 4× slow. The before and settled frames are each held 700 ms.                                          |
| `filmstrip.png`               | the reviewer | Every frame, labelled with its exact animation time in ms.                                                           |
| `filmstrip-reduced.png`       | the reviewer | The same trigger under `prefers-reduced-motion: reduce`.                                                             |
| `metrics.json`                | both         | Declared duration, easing and properties; rAF cadence, dropped frames, long frames, CLS; the reduced-motion verdict. |

A new row is `{ name, what, open, trigger, only, stepMs }`: `open` gets a fresh page to just before the motion,
`trigger` fires it, `only` selects the subject so an unrelated fade is listed under `others` instead. Use
`stepMs` 33 for motion of 0.5 s or more and 12 for `--motion-fast`. A row whose honest record is a cut goes in
`CUTS`, and the PR that gives it motion takes it out.

## The checks

Answer each from `filmstrip.png` and `metrics.json`. A PR says which passed, as "checklist 8/8".

1. **Every frame is a plausible blend of its two ends.** Nothing is offset, clipped, flashing, blank or doubled.
2. **No jump at either end.** Compare `before` with `0 ms`, and the last frame with the settled state. Anything
   that changes at `0 ms` without being in `declared` is a jump.
3. **The duration is a token** (`--motion-fast` 120, `--motion-base` 250, `--motion-slow` 400) or the PR says why
   not. Ease-out to enter, ease-in to leave.
4. **Reduced motion:** `reducedMotion.honoured` is true, and the motion's guard is the house
   `@media (prefers-reduced-motion: no-preference)` form, not an `animation: none` override.
5. **Only `transform` and `opacity` move things.** CLS is 0. A `properties` entry like `top`, `height` or
   `margin` is a red flag. (A colour fade is fine; it moves nothing.)
6. **An element placed with Tailwind `translate-*` animates `translate`/`scale`, never `transform`.** Tailwind v4's
   utilities set the `translate` property, so a keyframe `transform: translate(...)` applies the offset twice.
   This was the leave confirm bug.
7. **A comment that describes the motion matches the strip.** "Crossfade" must be a crossfade.
8. **It is readable.** `clip.gif` is under 2 MB and 4 s; `filmstrip.png` is at most 2000 px a side (crop with
   `stripClip`, shrink with `scale`).

## Putting the GIF in the PR

`gh` cannot attach images to a PR. The media goes on the `ui-review-media` branch instead, which shares no
history with `main`, and a PR comment links it. Images under `github.com/<repo>/blob/<branch>/<path>?raw=true`
render for anyone who can read the repo, on the phone app too, so nothing extra is needed for a private repo.

```sh
PR=964
M=$(mktemp -d)/media
git fetch origin ui-review-media && git worktree add --detach "$M" origin/ui-review-media
#   first time ever: git worktree add --orphan -b ui-review-media "$M"
mkdir -p "$M/pr-$PR" && cp -r core/tests/playwright/.artifacts/motion/<row> "$M/pr-$PR/"
git -C "$M" add "pr-$PR" && git -C "$M" commit -m "media: PR #$PR"
git -C "$M" push origin HEAD:ui-review-media
git worktree remove "$M"
```

Then in the comment: `![<row>](https://github.com/OnlyOneByte/Encore/blob/ui-review-media/pr-964/<row>/clip.gif?raw=true)`.
Each PR adds about 1 MB to that branch. A plain `git clone` fetches it; `--single-branch` does not.

## Limits

- **Headless numbers are not your TV.** The suite runs Chromium with `--disable-gpu`, so frame cadence and dropped
  frames are a floor on a dev box. Read them as regressions (0 becoming 5), not absolutes. The seek frames are
  exact by construction.
- **Only seekable motion.** CSS animations and transitions and WAAPI (Svelte 5 transitions included) step
  exactly. A script tween (the lyrics reel), `<video>` and canvas do not.
- **Clock-driven rows pay their clock three times** (seek, live, reduced). The TV attract phrase takes about 34 s.
- **The trigger is a Playwright click**, so tap-to-first-frame latency on a real touch screen is not measured.
- **GIFs use a 256-colour palette per frame**, so the TV's gradients band slightly. The strips are lossless.
