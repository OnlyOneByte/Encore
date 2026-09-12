# UI frames

**One set, stable filenames, regenerated in place.** Every frame here is `tour-<what>-eyeson.png`, and
the name is a *slot* rather than a snapshot: regenerate the set and every reference — the root README,
any doc, a PR body — picks up the new image without an edit. Nothing else lives in this folder.

That is a deliberate change. This directory used to carry 130 frames across a dozen id prefixes
(`m0c5-`, `m3c2-`, `b6-`, `b7c4-`, `b8-`, `ds-`, and sixteen stale `tour-` frames from earlier versions
of the capture), one family per piece of work that happened to take a screenshot. None of them were
regenerable — each was a frozen record of the UI on the day it was taken — so the folder grew
monotonically while only the `tour-` set ever told you what the app looks like *now*. The historical
frames were retired; the archive docs that cited them carry a note saying so.

The frames are **generated, not hand-taken**: each one is the real app driven into that state through
its real controls by `tests/e2e/capture.mjs`. That matters because the states worth looking at are
the ones a guest actually hits — a song cooking in the rotation, the sheet pulled up, the ball sitting
on the word being sung — and none of them are reachable by opening a URL.

`phone-ui-mock.html` stays: it is the original hand-drawn token source `app.css` was ported from, not a
captured frame.

## Regenerate

```bash
cd apps/core
ENCORE_EPHEMERAL=1 PORT=3500 MEDIA_DIR=./media bun run start
EPORT=3500 bun run e2e/capture.mjs                   # writes here by default
```

The capture applies the `tour-<what>-eyeson` naming itself, so a regenerated set cannot drift out of
the convention, and the file list here should be exactly what the capture emits — if it is not, either
a frame was added without regenerating or a stale one is lingering. `CAPTURE_ID` overrides the id
prefix; leave it alone unless you are deliberately producing a set that is *not* the current one.

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
