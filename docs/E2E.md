# The Chromium suite

`core/tests/playwright/`, run from `core/` with `bun run pw` (or one project: `gate:measured`, `pw:flow`,
`pw:probe`, `pw:shot`). Needs `bun run build` first — the specs serve the BUILT app, and `playwright.config.ts`'s
`globalSetup` fails with that remedy when `build/index.js` is absent. Paths below are relative to
`core/tests/playwright/` unless they say otherwise.

## Gates

Four kinds of artifact; the gate's timing half runs as its own project:

| Project      | Must it fail a build?                                    | What it holds                                                                                                                  |
| ------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `gate`       | **Yes** — leg 8 of `bun run gates`, and a step in CI     | CLAIM 1-8 and 15 on real resolved geometry, plus the register's own shape                                                      |
| `gate-speed` | **Yes** — the rest of `gate:measured`                    | the speed budget, CLAIM 9-14 (`measured-speed-*`): one worker, after `gate`, so the timings do not race the gate's own workers |
| `flow`       | `fuzz.spec.ts` runs in CI on its known seeds (see below) | long multi-client scenarios: party, playback, lobby, fuzz                                                                      |
| `probe`      | no — advisory `probes` check on every PR; nightly in CI  | one subject per spec                                                                                                           |
| `shot`       | **cannot** — a screenshot cannot fail a build            | frames, each driven INTO its state                                                                                             |

CI is `.github/workflows/ci.yml` (`gate:measured` in the `core` job, `--project=flow fuzz.spec.ts` in its own
`core-fuzz` job beside it) on every pull request
that touches more than `worker/**` and the worker/nightly/ml workflow files (its `changes` path filter), and
`.github/workflows/nightly.yml` (`--project=gate --project=flow --project=probe`).

### Probes on GitHub

`.github/workflows/probes.yml` runs `--project=probe` in four shards, plus `gate:measured`, on every pull request
and every push to `main` that changes more than docs, Markdown or the worker (its `paths-ignore`). It runs them
in the Playwright image on an internal Docker network, as [Running in Docker](#running-in-docker) prescribes. Its
`probes` job lists every failure by file:line in the run summary, then the flaky tests. Each shard's
`probes-<job>` artifact holds the HTML report, `results.json` and every test's `core.log`. The check is advisory,
not required.

**Reviewers read that job instead of re-running the probe set locally.** Run locally only the specs the PR
touches, or that exercise a path it changes (grep the probes for the changed functions and UI actions). A
failure there that also fails on `main`, or a flaky test in a spec this PR doesn't add or change, is not the
PR's.

A probe that needs YouTube cannot pass on a network with no route out. End its title with `@youtube`: the
hermetic run leaves it out and lists it, and `nightly.yml`, which has a network, still runs it.

Motion is `shot` too: `bun run ui:review` records each row of `specs/shot/motion.spec.ts` as a GIF, a
ms-labelled filmstrip and `metrics.json`. What a reviewer checks it against is [UI-CHECKLIST.md](UI-CHECKLIST.md).

**Which project a check belongs in is decided by whether it can silently regress, not by how
interesting it is.** The join gate's placement (a cascade / `:has()` / specificity stack across two hosts) is
`specs/gate/measured-join-gate.spec.ts`, CLAIM 7, for that reason. It asserts where the gate actually sits on
each host, not only that the two hosts agree: deleting `justify-content: center` leaves both hosts agreeing on a
top-aligned gate, so an equality-only check passes on a broken tree.

`specs/gate/measured-design-register.ts` holds the control register and the measured numbers the gate specs
read, including the quarantine entries; each entry carries its reason in the file.

## Speed gate

CLAIM 9-15 hold the [speed budget](UI-TENETS.md#speed-budget) and the TV safe area. The specs are
`specs/gate/measured-speed-{load,taps,waits}.spec.ts` (`gate-speed`) and `measured-tv-safe-area.spec.ts` (`gate`);
the measurer is `specs/gate/speed-measure.ts`.

| Claim | What                                                                               | Budget                                  |
| ----- | ---------------------------------------------------------------------------------- | --------------------------------------- |
| 9     | a cold load paints its primary control                                             | the budget table's row, at 1×           |
| 10    | tap to first visible change: Sing (+), dock tab, On deck key, Try again            | 100 ms at 1×                            |
| 11    | layout shift on cold loads and the phone session                                   | CLS 0                                   |
| 12    | no indicator on screen for under 300 ms; a lost party called lost after 3 s, by 4 s | 300 ms grace; 3-4 s from the first ask  |
| 13    | CSS and JS each route ships, gzipped                                               | a ceiling per route, ratchets down      |
| 14    | phone motion, declared duration plus delay                                         | 400 ms (`--motion-slow`)                |
| 15    | TV chrome inside `--tv-safe-x` / `--tv-safe-y` at 1920×1080, empty room and a song | 0 elements outside                      |

**Times are taken in the page, never in Node.** A tap is `performance.timeOrigin + event.timeStamp` of the real
`pointerdown`; the change is the first DOM mutation inside the control's own region, stamped at the next frame (rAF,
then one `MessageChannel` hop). A Node-side clock would add a CDP round trip that grows with host load. A cold load is
a fresh browser context per rep (empty HTTP cache, only the cookies the row needs), timed from navigation start to the
frame that shows the primary control, and never earlier than first contentful paint.

**A timing claim holds the best of N.** Host load only adds time, so the fastest rep is the product's own cost, while
a regression the product made slows every rep. The median is printed beside it. The `gate-speed` project runs on one
worker after `gate` (`dependencies`), so the timings never race the gate's own workers.

**The 4× rows are reported, never gated.** CDP CPU throttling at 4× on the measured page is the tenets' stand-in for
the slowest phone, but on a shared, loaded box a throttled page swings 2–3× between runs on identical code. The 4×
numbers are printed in the gate output and attached to the run (`speed-*.txt`), and are checked on a quiet machine or
by the reviewer's A/B run (main and branch, same box).

**What counts.**

- _Layout shift:_ every entry, the ones within 500 ms of input included. CLS proper drops those, but tenet 3 is
  "nothing moves that you didn't move", and a tap's own consequence jumping is what it rules out. A navigation starts
  a new record, so the session test reads its state before each `goto`.
- _Indicators:_ the `Spinner` ring, `SkeletonRows`, anything `aria-busy`, and a button or status line whose text is a
  loading word ("Loading…", "Searching…", "Finding the room…", "Joining…"). They are polled every 8 ms beside a
  MutationObserver, because an opacity step fires no mutation. One still on screen when the watch ends is not a flash.
- _Motion:_ every animation and transition `document.getAnimations()` reports, by its declared timing, so a loaded host
  reads the same numbers. Loops (a spinner, a shimmer) are indicators, and the strip's progress fill moves on
  `--motion-tick` by design; neither counts.
- _Bytes:_ each `stylesheet` and `script` response from the server, gzipped in the test, so the number is the build's
  and not the server's choice of encoding. A budget only ratchets down; raising one needs the owner's ruling.
- _TV safe area:_ every visible text-bearing element, image, button and icon under `.tv`. The backdrop, the visualiser
  and the lyric reel are the stage, not chrome; the reel's lines take their margin from their own padding and their
  position is not checked (CLAIM 5 covers their size only). The "no lyrics" status words are chrome and are checked. A
  canary word placed in the band proves the reader catches one.

**Known breaks.** A claim main fails today, by a named cause, is its own test. It runs its setup normally, then calls
`test.fail(true, 'KNOWN BREAK: <cause>, #<issue>')` right before its one assertion, so a broken setup is still red and only
the claim can be the expected failure. Fixing the cause turns it "Expected to fail, but passed"; the fixing PR deletes
the call. Each cause has its own test, so a fix flips only its own. None is open today: #1089 (QR "Finding the
room…"), #1090 (`/queue` "Loading the queue…") and #1092 (the Now card's `arrive`) are fixed and gate as plain tests
named for their issue. The lost party's words are timed in the page from the first `/api/me` ask, 3 s to 4 s plus a
timer's slack: when an `expect` poll finds them is up to a second late, which read as about 5 s (#1093).

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

**A test core has no internet, BY PROXY ONLY.** `startCore` boots core with `OFFLINE_ENV` (`world/core.ts`): every
`HTTP(S)_PROXY` variable points at a dead loopback port, and `NO_PROXY` keeps loopback direct. So the catalog searches,
lyrics lookups and the `yt-dlp` child, which inherits the env, fail at once, as on the hermetic Docker network, and core
still answers on `127.0.0.1`. Without it a GitHub runner's search answered with real catalog rows (#1134). **The limit
(#1405): it stops only clients that honour proxy variables.** Bun's `fetch` does, and so does every network path core
has today. A raw `Bun.connect` or `node:net` socket, a DNS lookup, or a child process that clears its env would reach
the network on a runner that has one; the hermetic network still blocks it locally. A new network client in core either
honours the proxy variables, or adds its own off switch to `OFFLINE_ENV`.

## Shared helpers

Everything a spec drives with lives in `world/`: `fixtures.ts` (above), `selectors.ts` (every hook; see
[below](#why-selectors-are-centralised)), `actors.ts` (route steps such as `openBrowseFromHome`, `openQueue`,
`returnHomeFromBrowse`, `queueReady`, `goOffline`), `workers.ts` (the [fake worker](#the-fake-worker)), `seed.ts` (the
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

## Running in Docker

Build the image the probes run in from `docker/playwright.Dockerfile`, the one CI's `probes.yml` builds: the
pinned Playwright base, the Bun core needs and ffmpeg. Rebuild it when either pin moves.

```sh
docker build -t encore-pw:1.56.1 -f docker/playwright.Dockerfile docker/
```

Run Playwright in Docker with `--network encore-hermetic` (made once with
`docker network create --internal encore-hermetic`), never `--network none`. With no network interface,
Chromium reports `navigator.onLine = false` from the start, so `setOffline(true)` fires no `offline` event and
the phone's "Reconnecting…" cue waits out its heartbeat. Take a page offline with `goOffline` (`actors.ts`),
which fails with that remedy instead.

## Keeping core's log

A failed test gets core's whole output as its `core.log` attachment. A passing test can still hide a server
error, such as a 500 on a page it only glanced at, so set `ENCORE_KEEP_CORE_LOG=1` to write every test's log to
`core.log` in its output directory under `tests/playwright/.artifacts/`. It is off by default; then
`grep -rl ' 500 \|Error' tests/playwright/.artifacts/*/core.log` finds the run to read.

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
fault options instead of env strings and the assign record directly readable. By default it advertises a full
worker, `['fetch:ytdlp', 'stems', 'align']`, so the room's `canMake` and `canFetch` are both true; a spec that
wants an uploads-only box passes `capabilities: ['stems', 'align']`.

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

The demo songs last 8 s. A spec that checks a lot while one song is current pauses the room first, or on a slow
runner the song ends by itself and the next step acts on the wrong song. A spec that skips on a phone whose strip
just changed waits out `SETTLE_MS` (`$lib/transport-target`) first, because the phone drops that tap on purpose
(one skip per tap). `reaction-row-return.spec.ts` does both.

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
