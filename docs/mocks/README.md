# UI frames

Eyes-on evidence. `<id>-<what>-eyeson.png`, where the id names the work that produced the frame
(`m0c5-`, `b7c4-`, `b8-` … and `ds-` for the design-system pass).

The `ds-` frames are **generated, not hand-taken**: each one is the real app driven into that state
through its real controls by `apps/core/e2e/capture.mjs`. That matters because the states worth looking
at are the ones a guest actually hits — a song cooking in the rotation, the sheet pulled up, the TV once
people have joined — and none of them are reachable by opening a URL.

Regenerate:

```bash
cd apps/core
bun run e2e:seed                                     # the demo library only indexes when files exist
ENCORE_EPHEMERAL=1 PORT=3500 MEDIA_DIR=./media bun run start
EPORT=3500 bun run e2e/capture.mjs                   # writes here by default
```

The capture applies the `ds-…-eyeson` naming itself, so a regenerated set cannot drift out of the
convention.

Two things to know when reading them:

- **The TV frames are 1920×1080 deliberately.** The stage type scale is `vh`-relative, so a frame taken
  at another height is measuring a different design.
- **Keep any frame under 2000px on both axes.** Beyond that an image cannot be read back by the agent
  tooling that reviews these, which silently costs you the review rather than erroring usefully.
