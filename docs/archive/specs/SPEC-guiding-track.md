# Guiding track — scope

> **Status:** BUILT on `feat/guiding-track`. Placement A (a slider in the sheet body) chosen by the
> owner. Grounded in the code at `46dada5`, then merged up to `30b8b6d`.
> Supersedes [`archive/reference/vocal-guide-spec.md`](archive/reference/vocal-guide-spec.md),
> which was written against v0.2.0 and is wrong about the most important thing: the worker
> **no longer discards the vocals stem.** It is already separated, encoded, written to disk, and
> preserved by retention. Roughly a third of that spec's plan was already shipped.

## 0. What was verified, and what was not

Verified against a real server (`bun run build` + `server.ts`) on an isolated copy of four real
cooked songs, driven over the real websocket:

- The backfill linked the vocals stem for real songs from real files, persisted the ref to SQLite
  **and** the sidecar, and the refs came back after the database was deleted.
- The `guide` command: `0.15` accepted, `9` clamped to `1`, `-3` to `0`, `0.1234` rounded to `0.12`,
  `null` clears to inherit, `0` pins an explicit off, `rev` advances on accept, a song change resets
  to `null`, and a malformed `player:command` frame leaves the room alive.
- The room default: `0.2` accepted, a junk write keeps `0.2`, `5` clamps to `1`.
- The TV mounts **both** media elements (instrumental `<video>` + vocals `<audio>`) from the room
  default alone, with no phone interaction — and at level `0` mounts **no** second element at all,
  which is the "the default costs nothing" claim.
- Every state of the phone control, rendered from the real component in a real browser via
  `/components`.

**Not verified: how it SOUNDS.** No audio hardware here, and no full ffmpeg on this box — the only
ffmpeg available is Playwright's screen-recording build, which cannot demux either m4a or FLAC. Two
consequences, both of which need a box with real ffmpeg and speakers:

1. **Drift is unmeasured.** The governor is implemented and the elements provably mount, but whether
   the guide stays inaudibly locked across a full song is exactly the thing a green suite cannot say.
2. **The silence refusal is unit-tested only.** `parseVolumeDetect`/`isDigitalSilence` are covered
   against real captured ffmpeg output, but the end-to-end refusal never ran here — the probe
   correctly reported "could not measure" and said so in the boot log. On a box with no usable probe
   the backfill links stems **unmeasured** and logs that plainly; the two known-silent songs in the
   live library will be refused on the deploy box, where ffmpeg is real.

## 1. What it is

The separated original vocals, mixed back **under** the instrumental at a level the singer
controls from the phone, applied live on the TV. `0%` is today's behaviour (pure karaoke). `15%`
is a faint guide for a song you half-know. `100%` is a sing-along.

Named **guiding track** in the UI. `guideLevel` in code.

## 2. What already exists (the good news)

| Fact | Where |
|---|---|
| `demucs` isolates **and publishes** vocals — AAC 192k in m4a, best-effort so a failure can't sink the instrumental | `apps/worker/src/demucs.py:184`, `:400-416` |
| `bs_roformer` does the same, same key, same shape | `apps/worker/src/roformer.py:135`, `:243-262` |
| The deterministic key builder exists | `apps/core/src/server/media/paths.ts:117` (`vocalsKey`, `VOCALS_EXT='m4a'`) |
| `JobArtifacts.stems.vocals` is typed and populated on the wire | `packages/shared/src/events.ts:158` |
| Retention **preserves** the vocals file rather than treating it as junk | `apps/core/src/server/media/retention.ts:64,173` |
| The `paths.ts` header already names "the future vocal guide" as a reason vocals is published | `paths.ts:113-117` |
| **7 of 9 cooked songs have a healthy vocals stem on disk right now** (4.1–6.5 MB each) | `apps/core/media/derived/stems/` |

So the audio exists. Nothing needs re-cooking for the majority of the library.

## 3. What's missing

Three real gaps, in order of size.

**3.1 Core drops the ref.** `worker-hub.ts:178-180` passes `artifacts.stems.instrumental` into
`markMediaReady` and lets `.vocals` fall on the floor. There is no `vocalsRef` on `Media`, no
column, no setter — even though `setMediaLyrics` and `setMediaPitch` are the exact pattern to copy.

**3.2 No mix parameter.** `PlaybackState` is four fields (`types.ts:120-125`); `PlayerCommand` is
six variants (`events.ts:64-72`). Neither carries a level.

**3.3 The TV plays exactly one element per slot.** `TvPlayer.svelte:44` is a single `<video>`.
There is **no volume, gain, or mute handling anywhere in the TV path**, and the only `AudioContext`
in the repo is `mic-capture.ts`, deliberately never connected to `destination`.

## 4. Design decisions

### 4.1 Two elements, not WebAudio

Keep the instrumental `<video>` as **master** — it keeps owning `play`/`pause`, `currentTime`,
`ended`, and the telemetry the gapless machine and the lyrics overlay run on. Add a sibling
`<audio>` for vocals that follows it, with `vocalsEl.volume = guideLevel` and a drift governor on
the master's existing `ontimeupdate` (~4 Hz): snap when off by >40 ms.

A full WebAudio graph buys sample-exact lock and effects. It also means rebuilding the playback
path that currently works. Not the starting point.

### 4.2 `guideLevel: number | null` — an override that clears

This is the decision that actually matters for whether the feature feels good.

`keyShift` resets to `0` on every song change. Copying that means a singer who wants a faint guide
re-drags the slider **every single song**. So instead:

- `RoomSettings.guideLevelDefault: number` — the party's default (ships at `0`).
- `PlaybackState.guideLevel: number | null` — `null` means *use the room default*; a number is a
  deliberate per-song override. Song change resets to `null`, not to `0`.

A `number|null` override-that-clears also keeps "the room wants 15%" and "this singer wants 0% for
this one song" distinguishable, which a bare number cannot.

### 4.3 Keep vocals as m4a

The vocals stem is AAC 192k because nothing played it aloud — it fed pitch extraction. Now it plays
aloud, so the question is fair. Answer: **keep it.** At guide levels (5–25%) it sits under a
lossless instrumental and 192k AAC is inaudibly transparent there. Switching to FLAC would roughly
double per-song derived storage and force a full re-cook of the library for a difference nobody can
hear under a backing track. Revisit only if the 100% sing-along tier gets real use.

### 4.4 A silent stem is worse than a missing one

Two of the nine cooked songs are the known silent-stem defect: instrumental *and* vocals are
digital silence, 44–124 KB against 14–28 MB healthy. `markMediaReady` verifies a ref **exists**,
never that it has content. A guide track built on that check advertises a working guide and
delivers four minutes of nothing. So publish-time gets one `ffmpeg -af volumedetect` probe:
`max_volume == mean_volume` at the −91 dB floor means absent, not ready.

### 4.5 keyShift is a non-problem today

The archived spec spends a whole section on the guide-vs-transpose clash, because a keyed
instrumental under key-0 vocals is musically wrong. But **keyShift is currently a no-op on the TV**:
neither `<TvPlayer>` receives the prop, so it defaults to `0` and the unkeyed instrumental always
plays (`tv/+page.svelte` ~200-221, `TvPlayer.svelte:11,39`; `ROADMAP.md:318` lists wiring it as open
work). The interaction is real but it is *that* feature's problem. Ship the guide unconditional, and
whoever wires keyShift owns muting the guide at non-zero shift.

## 5. Stages

Each stage is independently verifiable. S1 alone is worth landing.

**S1 — persist the ref (small, unblocks everything).** Add `vocalsRef?: string` to `Media`, a
`setMediaVocals` normalizing through `toRelativeKey` (mirror `setMediaLyrics`), and consume
`artifacts.stems.vocals` in `worker-hub.ts` `#onComplete`. Null it in the eviction reset alongside
`instrumentalRef`. Add the loudness probe (§4.4) so a silent stem never sets the ref.
*Verify:* unit — a complete with a vocals artifact sets the ref; a silent stem does not.

**S2 — backfill the existing library (cheap, no worker).** A boot-time scan mirroring
`backfillSidecars`: for each cooked song, existence-and-loudness-check `vocalsKey(id)` and populate
`vocalsRef`. Seven songs gain a guide track with zero CPU and zero downloads. The two silent ones
are correctly left without one.
*Verify:* run it against the live volume, assert 7 refs set and 2 skipped.

**S3 — the contract and the server.** `guideLevel: number | null` on `PlaybackState`;
`clampGuideLevel` beside `clampKeyShift` (pass `null` through, clamp numbers to `[0,1]`, non-finite
→ `null`); a `{ cmd: 'guide'; level: number | null }` command; a `case 'guide'` in `player.ts`
mirroring `case 'key'` but gated additionally on `media.vocalsRef`; `guideLevelDefault` on
`RoomSettings` + its normalizer. Reset `guideLevel: null` at **all three** song-start `setPlayback`
sites — `advance` (`player.ts:67`), `case 'play'` (`:88`), **and `reconcileOnReady` (`:56`)**, which
today resets neither this nor `keyShift` and is the site that gets forgotten.
Persistence: a `guide_level` column — note it must be **REAL or a scaled integer**, since
`keyShift` is `integer` and a fraction won't fit. The schema has no REAL precedent to copy.
Migration: the baseline's own header says stop squashing once deployed, and it *is* deployed to the
WSL2 box — so this is `0001_`, not a regenerated baseline.
*Verify:* unit — clamps; no-ops on a YouTube song, on a song with no `vocalsRef`; resets to `null`
on song change at all three sites; bumps `rev` and broadcasts.

**S4 — the TV mix.** The sibling `<audio>` in `TvPlayer.svelte`, volume, drift governor, and
teardown with the slot. Gate `onready` on **both** elements — this is the sharp edge: today
`oncanplaythrough` on the master alone drives the gapless swap, so an unmodified gate starts a song
whose guide hasn't buffered. Fall back to pure instrumental on the vocals element's `onerror`;
never let the guide break a song.
*Verify:* eyes-on with real audio — audible at 15%, drift inaudible across a full song, seek and
pause stay locked, the swap into the next song keeps its guide.

**S5 — the phone control.** See the mockup. Plus the room default in the "This room" settings
section, using the existing optimistic `patch('room', …)` helper.
*Verify:* eyes-on — dragging moves the TV level live; the unavailable state is correct on a song
with no vocals stem.

## 6. Hazards

1. **Four media elements.** Two slots × two elements, and the hidden slot pre-warms the *next*
   song — so a second `preload="auto"` doubles buffering and network during pre-warm on TV-class
   hardware.
2. **`onready` gating** (see S4). The most likely way this ships subtly broken.
3. **Autoplay policy.** The master swallows `play()` rejections (`TvPlayer.svelte:22`). A rejected
   vocals `play()` must degrade to a silent guide, never a stalled slot.
4. **The 0.25 s opacity crossfade** already overlaps two instrumentals; with a guide it overlaps
   four streams.
5. **Position source must stay the master.** Lyrics and progress read the master's `onposition`. If
   the guide element ever becomes the telemetry source, word timing drifts with it.
6. **A green suite proves nothing here.** This is an audio-mix feature; every real defect in it
   will be audible and invisible to tests. S4 does not close without ears on it.

## 7. Deliberately out of scope

- WebAudio graph, effects, ducking (§4.1).
- Keyed vocals variants / live pitch-shifting the guide (§4.5).
- Per-singer remembered guide level — that wants accounts (M9).
- Lead-vs-backing separation. Different feature, different models, and it needs the output-kind
  discriminator first. A guiding track is *turning the original singer down*; a karaoke split is
  *removing only the lead*. They are complementary, not substitutes.
