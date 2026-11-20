# The Chromium suite

`tests/playwright/`, run with `bun run pw` (or one project: `pw:gate`, `pw:flow`, `pw:probe`, `pw:shot`).
Needs `bun run build` first — the specs serve the BUILT app, and `playwright.config.ts`'s `globalSetup`
fails with that remedy when `build/index.js` is absent.

This replaced a hand-rolled tree of ~40 `.mjs` drivers (`tests/e2e/`, deleted). That tree had
re-implemented most of `@playwright/test`: 17 copies of `bail()`, 10 of `check()`, 31 readings of
`EPORT`, 31 hand-rolled `waitFor`s, 28 `/health` polls, 14 server spawns, and a 371-line runner. It is
worth knowing what was NOT recovered in the move, at the bottom of this file.

## Four projects, because there are four kinds of artifact

| Project | Must it fail a build?                         | What it holds                                             |
| ------- | --------------------------------------------- | --------------------------------------------------------- |
| `gate`  | **Yes** — it is leg 8 of `bun run gates`      | 8 specs: CLAIM 1-7 on real resolved geometry, plus the register's own shape |
| `flow`  | not yet wired into `gates`                    | long multi-client scenarios: party, playback, lobby, fuzz |
| `probe` | no — run when you want the answer             | 26 specs, one subject each                                |
| `shot`  | **cannot** — a screenshot cannot fail a build | 20 frames, each driven INTO its state                     |

**Which project a check belongs in is decided by whether it can silently regress, not by how
interesting it is.** `join-gate-placement.spec.ts` lived in `probe` while guarding the most
regression-prone fix in the tree — the join gate's placement, a cascade / `:has()` / specificity stack
across two hosts — so the one check on it never ran in `bun run gates`. It is now
`specs/gate/measured-join-gate.spec.ts` (CLAIM 7), strengthened on the way: the probe held three
deltas at zero, which cannot fail when both hosts break the same way, so the gate also asserts where the
gate actually sits. Verified by reverting the fix four ways, each rebuilt and re-run — deleting
`justify-content: center` leaves every delta at zero and reds 12 absolute arms.

## The `world` fixture

`tests/playwright/world/fixtures.ts` is the only thing that knows how to make a party happen. It gives a
spec `world.baseURL`, `world.mediaDir`, `world.code`, `world.joinAs(page, name)`, `world.openTv()`
(1920x1080), `world.openPhone(name)` (390x844, joined, its own browser context so its own cookie jar),
`world.awaitDemoTrack(match?)` and `world.core.log()`.

**A core boots PER TEST.** Not per worker, and that is forced rather than chosen: the room code renders
on `/tv` only while the room is EMPTY, and a boot mints exactly one room — so two tests sharing a core
cannot both start from a virgin room, and the second reads a lobby instead of a code. Measured cost is
~5-6s per test including boot, which buys complete isolation.

Both scratch directories are removed in teardown, unconditionally. They used not to be, and ~5MB per test
(four seeded WAVs plus whatever the fake worker published) filled a 460GB volume mid-session: 1101
orphaned directories, 4.3GB. The `stop()` that cleans the data dir guards only the KILL with an `if` —
an early `return` there skipped cleanup in exactly the crashed-core case that leaks most.

`test.use({ coreEnv: { … } })` reaches `startCore`'s environment, for a spec whose CONFIGURATION is the
experiment. It is an option fixture rather than something a test body sets, because core boots first.

## `world.awaitDemoTrack` exists because the library scan is detached

Core scans `MEDIA_DIR/library` in a boot pass that runs AFTER `/health` answers, spawning one ffmpeg per
file to read a duration. Measured: `?q=caroline` returns 0 local hits immediately after boot and 1 about
four seconds later. A phone that types before then searches an empty index and nothing re-runs the
query, which looks exactly like broken search rather than an early read.

Pass a **bare single token**. `awaitDemoTrack('sweet-caroline')` walks into a real product defect: the
hyphen makes `LocalLibrary.search` build `sweet-caroline*`, FTS5 throws at tokenise time, `safeSearch`
folds the throw to `[]`, and the helper times out blaming the scan. `p12-search` documents that defect.

## Environment failures THROW; they are never skipped

A missing build, a core that will not answer `/health`, a `PW_CHROMIUM` pointing at nothing — all are
errors with the remedy printed. This is a standing ruling in this repo: a permanently-skipped test is
indistinguishable from the rot it was meant to catch. Do not reach for `test.skip()` to paper over an
environment.

`test.fail()` is the opposite tool and is legitimate: it declares a KNOWN defect, the test still runs,
still fails for the documented reason, and the suite goes red if the behaviour ever changes. Five specs
use it. **Scope it to one test** — `test.fail()` at file scope applies to every test in the file, which
turned ten green tests red once.

## Chromium discovery

`world/chromium.ts` honours `PW_CHROMIUM` (validated: a wrong path throws with the path in it), then
falls back to the cache: the build the installed `@playwright/test` pins first, then the NEWEST
`chromium-*` / `chromium_headless_shell-*` build, in both the old `chrome-linux/` and the per-arch
`chrome-linux-arm64/`-style layouts. That fallback is not decoration: Playwright resolves by exact
revision, and a cache holding build 1223 against an `@playwright/test` wanting 1194 fails with
"Executable doesn't exist" while a perfectly good browser sits there. When no cached build launches on the
host (a newer build can need system libraries an old distro lacks), set
`PW_CHROMIUM=/path/to/chrome`, or run the suite in `mcr.microsoft.com/playwright:v<pinned>-noble`.

A per-file `test.use({ launchOptions })` **REPLACES** the config's rather than merging, so it silently
drops `executablePath`. Repeat `executablePath: resolveChromium()` and spread `BASE_LAUNCH_ARGS`, both from
`world/chromium.ts`.

## Autoplay: this box cannot refuse it

Measured three ways, by two independent agents: an unmuted `play()` succeeds from a cold load with no
input; `--autoplay-policy=user-gesture-required`, `=document-user-activation-required` and
`--headless=old` are all ignored; and `navigator.userActivation.hasBeenActive` is already `true` ~271ms
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

## Proving audio: decoded bytes, not `currentTime`

`webkitAudioDecodedByteCount` must CLIMB while the UI claims to be playing, sampled ~1.5s apart. That
dwell is a MEASUREMENT INTERVAL, not a workaround for missing auto-waiting — decoded bytes are a rate.
The distinction is the FLAC-in-a-`<video>` defect: valid file, element "playing", zero decoded bytes,
silent room. A run that never managed to evaluate the claim must FAIL, not pass.

The fixture audio is EMITTED, not encoded — `world/audio.ts` writes 16-bit PCM WAV by hand, because a box
may have a decode-only ffmpeg and no flac/sox/lame, and a RIFF header is 44 documented bytes.

## Selectors

`world/selectors.ts` is the one declaration of every hook a spec drives — 112 keys
(`Object.keys(SEL).length`). No spec may spell a
selector for itself: a hand-written one rots in silence, and three selector families moved at once while
the old suite stayed green. Anchor on the contract the app owes a user (`aria-label`, `data-testid`, a
vendored primitive's own `data-slot`) rather than on styling; a presentational class is the weakest handle
and is what rotted.

**What was lost:** `tests/guards/hygiene/contract.test.ts` used to verify every selector against the
source file it was supposed to resolve against, on every `bun test`. It is deleted along with the rest of
`tests/guards/`, and so is the `HOOKS` registry that recorded those anchors — an unverified record of
where a selector "should" resolve is worse than none, because it reads as a guarantee. Nothing now
notices a rotted selector until a spec opens the page and times out.

The retired-ids list at the top of `selectors.ts` warns rather than enforces, for the same reason. Its
point is durable: a revived name gets pointed at a class that has come BACK on another surface, so it
resolves — against the wrong thing, silently.

## Presence is a claim, so pick the right element to wait on

This section used to be about the now-playing sheet, which was mounted at all times — every selector
inside `.np-drawer` resolved cold, so a presence wait could never time out and "collapsed versus
pulled-up" had to be measured as a HEIGHT. The sheet is deleted and `openNowPlaying` with it; the
replacement is `openQueue`, which changes ROUTE and waits on the route's heading.

The trap it leaves behind is the opposite one, and it bites harder because the failure is a TIMEOUT
rather than a vacuous pass. In the bottom chrome:

- `SEL.dock` (`.dock`) is attached on EVERY phone surface for a joined singer, and on none before the
  join. That is what post-join readiness waits on — `world/fixtures.ts`, `world/actors.ts`, the measured
  gates and `preflight-reset-audit` all key on it.
- `SEL.npStrip` (`.dock .strip`) renders only when `hasSong || canStart`. **Its absence on an idle room is
  the contract**, not a missing hook: the band it replaced was permanently present and showed "Nothing
  playing" beside a disabled transport. So a readiness wait pointed at the strip times out legitimately
  on a virgin room, and a spec whose subject is the transport has to queue something first —
  `measured-dock.spec.ts` does exactly that, and says so.
- The same shape applies to `SEL.queueNowCard` (`.now`) on /queue and to `SEL.libraryReady` on /library:
  each renders on one arm of a branch, so a spec either asserts the arm it drove into or waits on a union.

The rule: wait on the element that is unconditional for the state you have actually reached, and assert
on the conditional one.

## Gestures

A synthetic `el.click()` is an UNTRUSTED event and grants no user activation, so it can neither unblock
autoplay nor resume an `AudioContext`. Use real Playwright input. For a drag, use `page.mouse` with
stepped moves — a handler reading pointer deltas needs real events.

## The fake worker

`world/workers.ts`: `startFakeWorker(world, opts)` dials home over the worker protocol, claims
`fetch`/`stems`/`align` jobs and publishes real audio; `startObservingWorker` claims nothing, so a spec
can READ the params core dispatches without completing the job. It runs in-process, which buys typed
fault options instead of env strings and the assign record directly readable.

Fault injection is typed: `silentInstrumental`, `silentVocals`, `skipWrite`, `noProfile`, `fail`,
`slowMs`, `noVocals`, `guideMix`. Each reaches a specific real state. Two to know: `noVocals` is a real
state rather than a fault (a worker that could not encode vocals reports none and the song stays
playable), and `guideMix` is the ONLY way to reach the ENABLED arm of the guiding-track slider.

## The fuzz spec

`specs/flow/fuzz.spec.ts` is a seeded-PRNG loop, not a scenario: it re-evaluates six invariants after
EVERY input, because the real defects lived in the ADJACENCY of inputs no curated sequence covers. One
long test, deliberately — a `test()` per input would reboot a core per input and destroy that adjacency.

`FUZZ_SEED` replays a run input for input, and the seed is printed at the start, in the summary and in
every violation. `FUZZ_INPUTS` sets the length. The catalogue is sorted by id before anything picks from
it, because `/api/library` ordering varies and two runs of one seed otherwise diverge on which song.

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

I6 cannot be dropped or weakened, and a run that never evaluated it FAILS on a non-vacuity floor rather
than passing quietly.

## Known-suspect, carried rather than fixed

- `LEAD_SEC` reads `settings.lyricsLeadMs`, but the sync frame carries `EffectiveSettings = {global, room}`
  — so it is always `undefined` and falls back to `0.3` while the real `DEFAULT_LYRICS_LEAD_MS` is `0`.
  **I4's window has been running 300ms off-centre.** Fixing it would move an assertion.
- The fuzz driver clamps `key` to ±9 where the server clamps to ±7.
- `guide` inputs are a server-side no-op unless `guideMixRef` exists, and the default worker publishes no
  guide mix — so they never reach the enabled arm. `guideMix: true` is the lever.

## A trap worth naming: the searching phone renders no rotation

`+page.svelte` gates the queued block on `{#if !searchActive}`, so a phone left in the search view
renders ZERO `.qrow` while the server's waiting set grows. Two separate ports hit this independently and
each manufactured a false failure from it — one a bogus I5 violation, one a presence check that could
only ever report "clicked but no local row". Return home (`returnHomeFromBrowse`) before counting rows.

## Load sensitivity

The audio specs are the load-sensitive ones: `p3-key-shift` passes 8/8 alone, fails 2 when run after
`p1`/`p2` in the same browser, and fails 6 at `--workers=3`, with `analyser tap: {"ok":false,
"why":"no-gain"}` — the pitch graph not finishing its build. Run the audio partition at `--workers=1`,
and treat a `no-gain` failure as unattributed rather than as a product claim until that is understood.

Concurrent runs must not share `outputDir`: Playwright WIPES it at startup, so two runs corrupt each
other's traces. Pass `--output=` when running alongside something else.

## The demo library

`tests/playwright/world/seed.ts` owns the demo fixture: four filenames, their tone, and the writer that
puts them under `MEDIA_DIR/library`. The `world` fixture calls it before core boots, because indexing the
library is a boot pass and a file written afterwards is not in it.

**FOUR is a ceiling on what this suite can observe, not just a count.** Two things sit outside it and are proved
in the unit suite instead, each named where it lives: the home shelf's row cap (`libraryShelf` — four tracks can
never truncate a cap of four, let alone the eight in force at `--bp-lg`, so a spec asserting the `See all N songs`
door would be permanently vacuous), and every
artist or tag facet (`trackNameFromFile` reads an artist only off the `Artist - Title.ext` form, and every fixture
filename is kebab-case, so there is no artist and no tag to find — `p12-search` documents the same gap for its own
artist-facet sections, and `p17-library-page` asserts the chip rows ABSENT because that is the honest observable).

It used to live in two halves — `server.ts` held the titles, artists and durations while `seed-media.mjs`
held the filenames — and the seeder's own header admitted the hazard: _"Must match the seededLibrary
sourceRefs in server.ts. NOT covered by the contract guard … so nothing reds if they drift apart."_
Three things were wrong with that arrangement, and all three are fixed:

- **It ran in production.** The seed had no environment guard, so every box — including a real
  deployment — wrote three YouTube rows (`demo-takeonme`, `demo-mrbrightside`, `demo-dancingqueen`) and
  four local tracks into its catalog on every boot.
- **It was the ONLY thing in the local library.** `LocalLibrary`'s comment claimed it "scans a media
  directory" and was "rebuilt from disk scan on boot", but nothing scanned: `index()` had exactly one
  caller, in `server.ts`, with that hardcoded list. A deployment that dropped real files into
  `MEDIA_DIR/library` indexed none of them. The `local library scan` boot pass in `app.ts` is the scan
  the comment always described.
- **The files were not decodable.** The seeder wrote 16-byte ISO-BMFF headers and said so: _"these are
  NOT decodable media — indexing/queueing only, never playback or processing"_. They are real 8-second
  WAV tones now, by way of `world/audio.ts`. This is no longer optional: core reads a duration with ffmpeg
  before indexing a library file and **skips** any file it cannot measure, because a track indexed at
  `durationSec: 0` is one the wait estimate reports as instant. Their 8 seconds is a fixture value.

The filename is the only metadata a library track has — `trackNameFromFile` splits `Artist - Title.ext`
on a spaced hyphen and treats anything else as all-title. The fixture keeps kebab-case names so specs can
match a stable substring (`sourceRef.includes('sweet-caroline')`) — but pass `awaitDemoTrack` a bare
token, not a hyphenated one, for the FTS5 reason above.

`/harness` and `/harness/phone` are likewise opt-in now, behind `ENCORE_DEV_HARNESS=1`: they are
unauthenticated pages that mint queue commands, so they are a tool you ask for rather than a surface
that is simply there. Their three buttons were hardcoded to the demo ids and are now built from
`/api/library`.
