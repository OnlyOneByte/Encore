# UI frames

Generated, not hand-taken. Every frame is the real app driven into that state through its real
controls by `apps/core/e2e/capture.mjs`, so nothing here is a mockup and nothing is stale by hand.

Regenerate:

```bash
cd apps/core
bun run e2e:seed                                   # the demo library only indexes when files exist
ENCORE_EPHEMERAL=1 PORT=3500 MEDIA_DIR=./media bun run start
EPORT=3500 bun run e2e/capture.mjs ../../docs/shots
```

The TV frames are captured at 1920x1080 deliberately: the stage type scale is vh-relative, so a frame
taken at another height is measuring a different design.

`tv-2-lobby` shows a known copy bug, left in place rather than papered over — a song IS queued (it is
cooking), but `screen.ts` only reaches its `waiting` state when the player is actively holding, so the
lobby line still reads "Waiting for someone to pick a song…".
