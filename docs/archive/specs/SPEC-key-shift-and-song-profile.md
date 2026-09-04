# Key shift + song profile

Shipped together. Two features, one PR, because the second's label is only truthful once the first
works: the phone rendered `Key · +2` while the TV played the original.

## Decisions

| # | Decision | Rejected, and why |
|---|---|---|
| 1 | Shift pitch **in the browser** (AudioWorklet OLA) | **Pre-render every variant:** 14 files/song at ~22 MB = ~310 MB, and 14 more to shift the guide stem too, tripling cook time. **Render on demand:** 5-10s latency, so the key could not apply mid-song. Browser shifting also works retroactively on the whole existing library. |
| 2 | Hand-write the shifter | `soundtouchjs` is LGPL; rubberband is GPL/commercial. |
| 3 | Delete `keyedMediaRef` + `apps/worker/src/pitch.py` | Both existed only to name/produce pre-rendered variants. `pitch.py` was tested pure logic with zero non-test callers — `processor.py` never called it. |
| 4 | Shift the guiding-track stem by the same amount | It was force-muted at non-zero key because the stem is rendered at key 0. The file path could not fix this without doubling the disk again. |
| 5 | Key + range as **one** JSON field, `songProfile` | Two fields would force the gate to name which one it required. One record makes "the step ran" a single check. |
| 6 | Name it `songProfile`, not `vocalProfile` | "Vocal profile" reads as the *singer's* profile — the thing explicitly cut — and is wrong about the key half, which comes from the instrumental. |
| 7 | Produce it inside the **`stems` job** | The old `score` job re-ran the entire separation to reach vocals it could read off disk. From inside the separation, both raw WAVs are already in scratch: no extra separation, no extra decode, no new job type. |
| 8 | Store tonic as an **integer pitch class**, spell at render time | A detector yields a pitch class, not a spelling. Storing `G#` makes the value wrong for every downward transposition. |
| 9 | **ASCII accidentals** (`G#`/`Ab`) | `icons.test.ts` bans 0x2600-0x27BF, which contains U+266F/U+266D. Independently correct: a stripped smart-TV font drops the sharp sign for the same reason it drops emoji. |
| 10 | Range disclosure in **now-playing only** | The song row is where "can I sing this?" is actually asked, but an inline row accordion does not exist in this repo and row height is the tightest budget in the app (~4 rows at 320px). The row gets the key chip only. A sheet opened from the row is the clean follow-up. |
| 11 | **Named voice bands** on the range axis | Without per-singer calibration a bare `D3 - A4` is unreadable to most people. Bands give an intrinsic frame with zero stored data. |
| 12 | No per-singer range calibration | `singers` is id/displayName/color/sessionToken/joinedAt with nowhere to put a range; accounts are M9. |
| 13 | Edit `0000_baseline.sql` **in place**, no new migration | No production instance exists; the test DB is nuked and re-cooked. |

## Traps this feature walked into

- **The gate must key on the RECORD, not on the data.** A silent vocals stem (2 of 9 library songs
  measured as digital silence) yields an all-null profile. If the gate required range data, that song
  is unsingable forever *and never re-cooks*, because the re-cook check reads `hasInstrumental`, not
  the gate. Same rule the `lyrics` gate already states: done means the step **ran**.
- **The wire shape drifted and both test suites passed.** The worker published `songProfile` as a
  sibling of `stems`; the core read `artifacts.stems.songProfile`. Always `undefined`, and with the
  gate requiring it, *every* separated song would have stalled at "Separating vocals" permanently.
  Each side mocked its own shape. Now declared on `JobArtifacts` and locked by a parity test that
  reads the Python source — the guard was verified by reintroducing the bug and watching it red.
- **A source guard can flag its own documentation.** That parity test's first version matched the bad
  path inside the comment explaining the bad path. `icons.test.ts` warns about exactly this; strip
  comments before scanning.
- **Overlapping voice ranges cannot be adjacent stripes.** Bass E2-E4 through soprano C4-C6 overlap
  heavily. The shading splits at midpoints between band centres and is an approximation *on purpose*;
  the claim made in words comes from the true ranges. Do not "fix" the zones into precise ranges.
- **`pitch_track.py` vanished mid-build.** `a9ebd4b Remove live scoring entirely` deleted the numpy
  tracker while this work was in flight, so the range summarizer carries its own.

## Verified / not verified

| | |
|---|---|
| Verified | 1101 bun tests, svelte-check 0/0, 390 worker pytest. Schema proven by migrating a throwaway DB and reading `PRAGMA table_info(media)`. Parity guard proven by reintroducing the bug. |
| **Not verified** | **Whether the pitch shift sounds right.** No audio hardware on the dev box and no `AudioContext` in `bun:test`, so only the ratio/framing/window maths is covered. The OLA quality, the suspended-context fallback, and the graph lifecycle need the RTX 3080 box and a human in the room. |
| Not verified | Real key-detection accuracy on real songs — tested against synthesized tones only. Expect relative-major/minor and fifth confusions; the confidence floor hides the worst of it. |
