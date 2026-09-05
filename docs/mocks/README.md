# UI frames

Eyes-on evidence. `<id>-<what>-eyeson.png`, where the id names the work that produced the frame —
`m0c5-`, `b7c4-`, `b8-`, `ds-` for the design-system pass, and **`tour-` for the current full-surface
set**. The `tour-` frames are the ones the README links and the ones to regenerate; the older ids are
kept as the record of the work that first produced them, and show the UI as it was at that time.

The `tour-` and `ds-` frames are **generated, not hand-taken**: each one is the real app driven into
that state through its real controls by `apps/core/e2e/capture.mjs`. That matters because the states
worth looking at are the ones a guest actually hits — a song cooking in the rotation, the sheet pulled
up, the ball sitting on the word being sung — and none of them are reachable by opening a URL.

## Regenerate

```bash
cd apps/core
ENCORE_EPHEMERAL=1 PORT=3500 MEDIA_DIR=./media bun run start
EPORT=3500 bun run e2e/capture.mjs                   # writes here by default
```

The capture applies the `<id>-<what>-eyeson` naming itself, so a regenerated set cannot drift out of
the convention. `CAPTURE_ID` overrides the id.

**Two things decide whether the interesting half of the set is real, and both fail quietly.**

1. **A media volume with genuinely cooked songs** — stems, lyrics, and a `songProfile`. `bun run
   e2e:seed` writes *undecodable placeholders*: enough for search, queueing and rotation, but the song
   cannot play, so every playing/lyrics/stage-look frame degrades to a lobby or a cannot-play screen.
   The capture says which frames it skipped and why, so check that summary rather than the file count.
   Songs cooked before the song-profile feature landed have no profile and therefore never leave
   `cooking`, which looks identical to having no worker.
2. **Playback actually advancing.** Headless Chromium will not start an unmuted media element without
   a user gesture, so `--autoplay-policy=no-user-gesture-required` is necessary — and *not sufficient*.
   The capture starts the element by hand and then **verifies the position moved** before it trusts any
   playing frame. This matters because the failure is invisible: the lower third is up, the lyrics are
   rendered, everything looks plausible, and the only tell is that the reel is frozen on the song's
   first line in all twenty-odd frames. The room also starts a queued song itself, so a single
   play/pause click can *pause* it — which is exactly what produced a set of frozen frames before the
   verification was added.

## Reading them

- **The TV frames are 1920×1080 deliberately.** The stage type scale is `vh`-relative, so a frame taken
  at another height is measuring a different design.
- **Keep any frame under 2000px on both axes.** Beyond that an image cannot be read back by the agent
  tooling that reviews these, which silently costs you the review rather than erroring usefully. The
  desktop pages size their viewport to their own content for this reason, capped at 2000.
- The join QR encodes whatever `ENCORE_PUBLIC_ORIGIN` (or the Joining setting) says. `tour-tv-join-
  unreachable-eyeson.png` is the deliberate opposite: the screen a room shows when it is advertising an
  address phones cannot reach.
