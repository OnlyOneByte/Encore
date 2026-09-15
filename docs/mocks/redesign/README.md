# Redesign frames — PR-scoped, and meant to be deleted

These four frames exist so a reviewer can see the rebuilt phone remote without running it. They are
**not** part of the `tour-<what>-eyeson.png` set one directory up, and they deliberately do not follow
its naming: that set is a single regenerable series with stable filenames, and adding a second series
into it is exactly what the parent README says not to do.

**Delete this directory the next time `tests/e2e/capture.mjs` runs against a real media volume.** That
run refills the `tour-phone-*` slots with the new surfaces, every existing reference picks them up with
no edit, and these become a stale copy of frames that already exist properly.

## Why they are not just a regenerated tour set

`capture.mjs` writes the whole set or none of it — there is no per-frame filter — and the interesting
half of it needs a media volume with **genuinely processed** songs: stems, lyrics and a `songProfile`.
`bun run e2e:seed` writes undecodable placeholders, so every playing, lyrics and stage-look frame
degrades to a lobby or a cannot-play screen. Regenerating from a placeholder volume would therefore
replace a set of accurate TV frames with a set of degraded ones to refresh the phone half. That trade is
not worth making from this branch, so the phone frames in `docs/mocks/` are stale until someone runs the
capture properly, and this directory covers the gap in the meantime.

## What each one shows

| Frame | Surface |
| --- | --- |
| `phone-queue-home.png` | `/` — the queue, and nothing else. No hero. The band is the bottom chrome. |
| `phone-drawer.png` | the band pulled up into the now-playing drawer, over a dimmed queue |
| `phone-find.png` | `/find` — search, with the saved library as its zero-query state |
| `phone-song.png` | `/song/[mediaId]` — one song's facts, reached from the drawer's `···` |

All four are the real app driven into that state through its real controls, at 390×844 DPR 2, against
an ephemeral server with the seeded demo library. The room is idle in three of them because a
placeholder volume cannot play a song — which is the same limitation described above, not a defect in
the surfaces.
