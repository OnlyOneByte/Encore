# Real lyrics corpus — provenance and what each file is for

Eight lyrics artifacts taken verbatim off a real party's media store. They are the worker's first
real **lyrics** fixtures; before this, every input in `worker/tests/` was an inline Python
string, which is fine for pinning an invariant and useless for calibrating a threshold. Position and
repetition are properties of real song structure — where a chorus recurs, how many times, how long a
tail runs — so a number tuned against invented text is tuned against whoever typed it.

Committed under owner ruling **Q1 = B** (the raw snapshot branch stays as the archive
of record) and **Q2 = C** (a curated subset now, with this README naming the source so more can be
pulled later).

## Source

| | |
|---|---|
| branch | `debug_real_data_e2bc8c16710db759137379a47efa9b3ab7f63f11` |
| commit | `e5ffab6` |
| archive | `debug_encore/archive2.zip` (1,746,000 bytes) |
| holds | 2273 `media/meta` sidecars and 30 `media/derived/lyrics` artifacts |

**Keeping this table accurate is the whole mechanism.** A stale commit makes the other 22 artifacts
and 2273 sidecars unreachable in practice, which turns every file here into an unexplained blob. If
the branch is ever renamed or rewritten, fix this table in the same commit.

The media ids are kept **intact**. Renaming them was considered and rejected: the raw archive is
already committed with the ids on the branch above, so renaming here would not un-commit anything and
would only break the trace from a fixture back to its source.

## The files

Machine-readable provenance — media id, source ref, duration, sha256, and the one property each file
exists to pin — is in `manifest.json`, which `tests/test_lyrics_corpus_668.py` reads. The duration
lives there rather than in the artifacts because a published lyrics artifact carries only
`{language, lines, words}`; the audio duration comes from the media sidecar, and the overshoot
measurement needs it.

| file | what it is | why it is here |
|---|---|---|
| `wrong-version-overshoot-total-eclipse.json` | Bonnie Tyler, 268s audio, text timed to 373.8s | wrong version, labelled by construction — 25 of 97 lines start after the song ends |
| `wrong-version-overshoot-friends-in-low-places.json` | Garth Brooks, 281s audio, text to 357.1s | the second, shallower wrong-version case — one case cannot show a band |
| `clean-control-since-u-been-gone.json` | Kelly Clarkson, 48 lines ending 185.0s in 191s | the negative case, so an overshoot guard cannot pass vacuously |
| `same-audio-pair-japanese-goblin-asr.json` | degenerate `ja` ASR, 1594 words in 12 lines | a baseline that clears `MIN_TOKENS_TO_COMPARE` and therefore votes |
| `same-audio-pair-japanese-goblin-captions.json` | authored `en` captions, same upload | the candidate half — the archive's only same-audio pair |
| `junk-glyph-line-skyfall.json` | Adele, line 1 is a bare music glyph | real authoritative text whose first line tokenises to nothing |
| `caption-line-mr-brightside.json` | 32 timed lines, zero timed words | the line-only sync floor case |
| `caption-word-legends-never-die.json` | 46 lines, 252 timed words | the word-level counterpart, so the tier split is measurable |

Total 425 KB. The remaining 22 artifacts were left on the branch deliberately: an uncurated fixture
set invites tests that assert whatever the data happens to say, which is how a corpus stops pinning
anything.

## What this corpus measures, and what it still does not

Measured through the production functions in `worker/src/lyrics/chain.py`, not re-derived here.

### `OVERSHOOT_FRACTION_MAX = 0.10` — calibrated

| specimen | overshoot fraction |
|---|---|
| Total Eclipse (wrong version) | **0.3948** |
| Friends in Low Places (wrong version) | **0.2709** |
| every same-recording specimen (5 of them) | **0.0000** |

The two classes are separated by 0.271 with nothing in between. `0.10` sits inside that gap with
0.171 of margin below the nearest wrong-version case and the full 0.10 above the clean floor. The
constant's own comment quoted +39% and +27% from the issue that filed it; these are the same two
numbers measured through `candidate_last_end` on the committed bytes, plus five real negatives the
comment did not have.

### `SUSPECT_COVERAGE = 0.40` — **not** calibrated by this corpus

`chain.py` says to re-derive this number once a real corpus lands. It cannot be re-derived from these files,
and that is worth stating plainly rather than quietly shipping a threshold that looks corpus-backed.

A coverage threshold needs real **(candidate, baseline)** pairs, and the archive holds exactly one:
the Japanese Goblin upload. Its two texts are in different languages, so the measured coverage is
**0.0** — a single point at the extreme end, not a band. Worse, the degenerate `ja` ASR baseline has
30 distinct tokens against a floor of 12, so it **votes** rather than abstaining, and one extreme
vote constrains a threshold no better than no vote at all.

Discharging the debt needs the `baselines/` half of the revised proposal: machine caption tracks
re-fetched per `origin.sourceRef`, which pairs a real baseline with each archived candidate. Note the
ordering dependency recorded on the issue — those tracks carry rolling scroll-overlap duplication
, which inflates token counts, so a count-aware metric calibrated on them would be measuring
YouTube's cue format rather than the song.

`tests/test_lyrics_corpus_668.py` pins the pair count at one, so the day an interior pair is added
the suite reds and this section has to be rewritten with a real band.
