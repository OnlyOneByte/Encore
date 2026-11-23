# The Chromium suite

`core/tests/playwright/`, run from `core/` with `bun run pw` (or one project: `gate:measured`, `pw:flow`,
`pw:probe`, `pw:shot`). Needs `bun run build` first — the specs serve the BUILT app, and `playwright.config.ts`'s
`globalSetup` fails with that remedy when `build/index.js` is absent. Paths below are relative to
`core/tests/playwright/` unless they say otherwise.

## Gates

Four projects, because there are four kinds of artifact:

| Project | Must it fail a build?                                    | What it holds                                                               |
| ------- | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| `gate`  | **Yes** — leg 8 of `bun run gates`, and a step in CI     | 8 specs: CLAIM 1-7 on real resolved geometry, plus the register's own shape |
| `flow`  | `fuzz.spec.ts` runs in CI on its known seeds (see below) | long multi-client scenarios: party, playback, lobby, fuzz                   |
| `probe` | no — run when you want the answer; nightly in CI         | one subject per spec                                                        |
| `shot`  | **cannot** — a screenshot cannot fail a build            | frames, each driven INTO its state                                          |

CI is `.github/workflows/ci.yml` (`gate:measured`, then `--project=flow fuzz.spec.ts`) on every pull request
that touches more than `worker/**` and the worker/nightly workflow files (its `paths-ignore`), and
`.github/workflows/nightly.yml` (`--project=gate --project=flow --project=probe`).

Motion is `shot` too: `bun run ui:review` records each row of `specs/shot/motion.spec.ts` as a GIF, a
ms-labelled filmstrip and `metrics.json`. What a reviewer checks it against is [UI-CHECKLIST.md](UI-CHECKLIST.md).

**Which project a check belongs in is decided by whether it can silently regress, not by how
interesting it is.** The join gate's placement (a cascade / `:has()` / specificity stack across two hosts) is
`specs/gate/measured-join-gate.spec.ts`, CLAIM 7, for that reason. It asserts where the gate actually sits on
each host, not only that the two hosts agree: deleting `justify-content: center` leaves both hosts agreeing on a
top-aligned gate, so an equality-only check passes on a broken tree.

`specs/gate/measured-design-register.ts` holds the control register and the measured numbers the gate specs
read, including the quarantine entries; each entry carries its reason in the file.

## The `world` fixture

`world/fixtures.ts` is the only thing that knows how to make a party happen. It gives a
spec `world.baseURL`, `world.mediaDir`, `world.code`, `world.joinAs(page, name)`, `world.openTv()`
(1920x1080), `world.openPhone(name)` (390x844, joined, its own browser context so its own cookie jar),
`world.awaitDemoTrack(match?)` and `world.core.log()`.

**A core boots PER TEST.** Not per worker, and that is forced rather than chosen: the room code renders
on `/tv` only while the room is EMPTY, and a boot mints exactly one room — so two tests sharing a core
cannot both start from a virgin room, and the second reads a lobby instead of a code.

Both scratch directories are removed in teardown, unconditionally, including when the core crashed.

`test.use({ coreEnv: { … } })` reaches `startCore`'s environment, for a spec whose CONFIGURATION is the
experiment. It is an option fixture rather than something a test body sets, because core boots first.

## Shared helpers

Everything a spec drives with lives in `world/`: `fixtures.ts` (above), `selectors.ts` (every hook; see
[below](#why-selectors-are-centralised)), `actors.ts` (route steps such as `openBrowseFromHome`, `openQueue`,
`returnHomeFromBrowse`, `queueReady`), `workers.ts` (the [fake worker](#the-fake-worker)), `seed.ts` (the
[demo library](#the-demo-library)), `audio.ts` (WAV writer), `autoplay.ts` ([autoplay](#autoplay)),
`chromium.ts` ([discovery](#chromium-discovery)), plus `presence.ts`, `reactions.ts`, `motion.ts` and
`motion-realtime.ts`.

## `world.awaitDemoTrack` exists because the library scan is detached

Core scans `MEDIA_DIR/library` in a boot pass that runs AFTER `/health` answers, spawning one ffmpeg per
file to read a duration. A phone that types before the scan finishes searches an empty index and nothing re-runs
the query, which looks exactly like broken search rather than an early read.

Pass a **bare single token**. `awaitDemoTrack('sweet-caroline')` walks into a real product defect: the
hyphen makes `LocalLibrary.search` build `sweet-caroline*`, FTS5 throws at tokenise time, `safeSearch`
folds the throw to `[]`, and the helper times out blaming the scan. `p12-search` documents that defect.

## Environment failures THROW; they are never skipped

A missing build, a core that will not answer `/health`, a `PW_CHROMIUM` pointing at nothing — all are
errors with the remedy printed. A permanently-skipped test is indistinguishable from the rot it was meant to
catch, so do not reach for `test.skip()` to paper over an environment.

`test.fail()` is the opposite tool and is legitimate: it declares a KNOWN defect, the test still runs,
still fails for the documented reason, and the suite goes red if the behaviour ever changes. **Scope it to one
test** — `test.fail()` at file scope applies to every test in the file.

## Chromium discovery

`world/chromium.ts` honours `PW_CHROMIUM` (validated: a wrong path throws with the path in it), then
falls back to the cache: the build the installed `@playwright/test` pins first, then the NEWEST
`chromium-*` / `chromium_headless_shell-*` build, in both the old `chrome-linux/` and the per-arch
`chrome-linux-arm64/`-style layouts. That fallback is not decoration: Playwright resolves by exact
revision, and a cache holding a different build than the one `@playwright/test` wants fails with
"Executable doesn't exist" while a perfectly good browser sits there. When no cached build launches on the
host (a newer build can need system libraries an old distro lacks), set
`PW_CHROMIUM=/path/to/chrome`, or run the suite in `mcr.microsoft.com/playwright:v<pinned>-noble` (CI does).

A per-file `test.use({ launchOptions })` **REPLACES** the config's rather than merging, so it silently
drops `executablePath`. Repeat `executablePath: resolveChromium()` and spread `BASE_LAUNCH_ARGS`, both from
`world/chromium.ts`.

## Autoplay

Headless Chromium here cannot be made to refuse autoplay: an unmuted `play()` succeeds from a cold load with no
input; `--autoplay-policy=user-gesture-required`, `=document-user-activation-required` and
`--headless=old` are all ignored; and `navigator.userActivation.hasBeenActive` is already `true` shortly
after load with nothing touching the page. Playwright compounds it — CDP evaluations carry
`userGesture: true`, so merely READING the page grants the frame sticky activation.

So the blocked state is unreachable by configuration, and a spec asserting "the hint appeared" would pass
for the wrong reason forever. `world/autoplay.ts` re-imposes the policy IN-PAGE:
`requireActivationForPlayback(page, { gateAudioContext })` rejects an unmuted `play()` with a real
`NotAllowedError` until a TRUSTED event arrives, and `autoplayIsBlocked(page)` is the premise check to
assert BEFORE asserting the app's reaction. It checks `event.isTrusted`, so a synthetic `el.click()`
unblocks nothing — which is what makes a tap-to-start test mean anything.

It is a stand-in for the one rule the app branches on, not a policy engine. A spec using it asserts that
the APP HANDLES a refusal; it does not assert that this Chromium refuses. Say which you mean.

Never grant `--autoplay-policy=no-user-gesture-required` as a default: a television grants no gesture, so
proving playback with the policy relaxed proves it in an environment the product never ships into.

## Proving audio

Decoded bytes, not `currentTime`. `webkitAudioDecodedByteCount` must CLIMB while the UI claims to be playing,
sampled ~1.5s apart. That dwell is a MEASUREMENT INTERVAL, not a workaround for missing auto-waiting — decoded
bytes are a rate. The distinction is the FLAC-in-a-`<video>` defect: valid file, element "playing", zero
decoded bytes, silent room. A run that never managed to evaluate the claim must FAIL, not pass.

The fixture audio is EMITTED, not encoded — `world/audio.ts` writes 16-bit PCM WAV by hand, because a box
may have a decode-only ffmpeg and no flac/sox/lame, and a RIFF header is 44 documented bytes.

## Why selectors are centralised

`world/selectors.ts` is the one declaration of every hook a spec drives. No spec may spell a selector for
itself: a hand-written one rots in silence.

### Anchor discipline

Anchor on the contract the app owes a user (`aria-label`, `data-testid`, a vendored primitive's own
`data-slot`) rather than on styling; a presentational class is the weakest handle and is the one that rots.
Nothing verifies a selector against the source it should resolve in, so a rotted selector shows up only when a
spec opens the page and times out.

The retired-ids list at the top of `selectors.ts` warns rather than enforces. Its point is durable: a revived
name gets pointed at a class that has come BACK on another surface, so it resolves — against the wrong thing,
silently.

## Presence is a claim, so pick the right element to wait on

In the bottom chrome:

- `SEL.dock` (`.dock`) is attached on EVERY phone surface for a joined singer, and on none before the
  join. That is what post-join readiness waits on — `world/fixtures.ts`, `world/actors.ts`, the measured
  gates and `preflight-reset-audit` all key on it.
- `SEL.npStrip` (`.dock .strip`) renders with the dock. Its transport (`SEL.npTransport`, `SEL.npPlayPause`)
  renders only when a song is on or the queue is non-empty (`live` in `src/lib/ui/NowPlayingStrip.svelte`); an
  idle room shows `SEL.npStripIdle` ("Nothing playing") and **no transport — that absence is the contract**. A
  spec whose subject is the transport has to queue something first; `measured-dock.spec.ts` measures both
  states.
- The same shape applies to `SEL.queueNowCard` (`.now`) on /queue and to `SEL.libraryReady` on /library:
  each renders on one arm of a branch, so a spec either asserts the arm it drove into or waits on a union.

The rule: wait on the element that is unconditional for the state you have actually reached, and assert
on the conditional one.

## Gestures

A synthetic `el.click()` is an UNTRUSTED event and grants no user activation, so it can neither unblock
autoplay nor resume an `AudioContext`. Use real Playwright input. For a drag, use `page.mouse` with
stepped moves — a handler reading pointer deltas needs real events.

## The fake worker

`world/workers.ts`: `startFakeWorker(world, opts)` connects over the worker protocol, claims
`fetch`/`stems`/`align` jobs and publishes real audio; `startObservingWorker` claims nothing, so a spec
can READ the params core dispatches without completing the job. It runs in-process, which buys typed
fault options instead of env strings and the assign record directly readable.

### Fault injection

Typed options: `silentInstrumental`, `silentVocals`, `skipWrite`, `noProfile`, `fail`, `slowMs`, `noVocals`,
`guideMix`. Each reaches a specific real state. Two to know: `noVocals` is a real state rather than a fault (a
worker that could not encode vocals reports none and the song stays playable), and `guideMix` is the ONLY way to
reach the ENABLED arm of the guiding-track slider.

## Fuzzing the room

`specs/flow/fuzz.spec.ts` is a seeded-PRNG loop, not a scenario: it re-evaluates six invariants after
EVERY input, because the real defects lived in the ADJACENCY of inputs no curated sequence covers. One
long test per seed, deliberately — a `test()` per input would reboot a core per input and destroy that adjacency.

Which seeds run: `FUZZ_SEED` replays that one seed, input for input. Without it, the run replays every seed in
`specs/flow/fuzz-seeds.ts` (seeds that once broke an invariant; `open: true` rows are known bugs held by
`test.fail` for the named invariant only), so a CI run is the same run every time. `FUZZ_RANDOM=1` draws a fresh
seed, which is what the nightly job does. The seed is printed at the start, in the summary and in every
violation, as a replay line to paste into `fuzz-seeds.ts`. `FUZZ_INPUTS` sets the length. The catalogue is
sorted by id before anything picks from it, because `/api/library` ordering varies and two runs of one seed
otherwise diverge on which song.

### The fuzz invariants

|     | Holds that                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------- |
| I1  | `currentTime` is monotonic within a song; it may fall only across a seek, restart or entry change    |
| I2  | exactly one queue entry is `playing` — not zero while the TV renders a song, not two                 |
| I3  | the TV's RENDERED now-playing equals the SERVER's `currentEntryId`, read off the server's own socket |
| I4  | the lyrics active index is consistent with `currentTime` — the active line's window contains it      |
| I5  | no entry is both `playing` and waiting, and the phones' rendered rotation agrees with the server     |
| I6  | decoded bytes CLIMB whenever the UI claims to be playing                                             |

I2/I3/I5 are cross-surface and therefore asynchronous by design, so they are retried against FRESH
snapshots until they hold or the budget expires; I1/I4/I6 are single-surface and read once. Do not make
them all polls (that hides real violations) or all single reads (that manufactures false ones).

I6 cannot be dropped or weakened, and a run that never evaluated it FAILS rather than passing quietly.

### Known gaps in the driver

- The fuzz driver clamps `key` to ±9 where the server clamps to ±7 (`MAX_KEY_SHIFT`).
- `guide` inputs are a server-side no-op unless `guideMixRef` exists, and the default fake worker publishes no
  guide mix — so they never reach the enabled arm. `guideMix: true` is the lever.

### Count rotation rows on /queue

The Sing tab (`/`) renders no `.qrow`; the rotation is `/queue`. A phone left on the Sing tab or in search
reads ZERO rows while the server's waiting set grows, which manufactures a false I5 or a presence check that
can never pass. The fuzz driver returns each phone to `/queue` after an add (`restOnQueue`) for this reason.

## Load sensitivity

The audio specs are the load-sensitive ones: `p3-key-shift` can fail when run after `p1`/`p2` in the same
browser or at `--workers=3`, with `analyser tap: {"ok":false, "why":"no-gain"}` — the pitch graph not finishing
its build. Run the audio partition at `--workers=1`, and treat a `no-gain` failure as unattributed rather than as
a product claim until that is understood.

Concurrent runs must not share `outputDir` (`tests/playwright/.artifacts`): Playwright WIPES it at startup, so
two runs corrupt each other's traces. Pass `--output=` when running alongside something else.

## The demo library

`world/seed.ts` owns the demo fixture: four filenames, their tone, and the writer that puts them under
`MEDIA_DIR/library` as real 8-second WAV tones (by way of `world/audio.ts`). The `world` fixture calls it
before core boots, because indexing the library is a boot pass and a file written afterwards is not in it. Core
reads a duration with ffmpeg before indexing a library file and **skips** any file it cannot measure, because a
track indexed at `durationSec: 0` is one the wait estimate reports as instant.

**FOUR is a ceiling on what this suite can observe, not just a count.** Artist and tag facets sit outside it
and are proved in the unit suite instead: `trackNameFromFile` reads an artist only off the `Artist - Title.ext`
form, and every fixture filename is kebab-case, so there is no artist and no tag to find — `p12-search`
documents the same gap for its own artist-facet sections, and `p17-library-page` asserts the chip rows ABSENT
because that is the honest observable.

The filename is the only metadata a library track has — `trackNameFromFile` splits `Artist - Title.ext`
on a spaced hyphen and treats anything else as all-title. The fixture keeps kebab-case names so specs can
match a stable substring (`sourceRef.includes('sweet-caroline')`) — but pass `awaitDemoTrack` a bare
token, not a hyphenated one, for the FTS5 reason above.

`/harness` and `/harness/phone` are opt-in, behind `ENCORE_DEV_HARNESS=1` (`src/lib/server/dev-harness.ts`):
they are unauthenticated pages that mint queue commands, so they are a tool you ask for rather than a surface
that is simply there.
