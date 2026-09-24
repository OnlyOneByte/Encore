# End-to-end harness

How the browser-driven checks are built and what they promise. `bun run e2e:probes` runs the probe
suite, `bun run gate:measured` the measured-design gate. `tests/e2e/HARNESS.md` carries the boot
recipes and this box's tool inventory; this document carries the contracts.

## The harness and the selector contract

Two rungs, and only one of them needs a browser.

- **The guard — RETIRED.** `tests/guards/hygiene/contract.test.ts` ran inside `bun run test` and red the
  moment a selector's source anchor disappeared, which made it the load-bearing half: it proved the drivers
  were still aimed at the app. The whole `tests/guards/` tree is deleted, so NOTHING now verifies that a
  selector still resolves until a browser run opens the page. That is a real loss of coverage, not a
  simplification — a renamed class is now found by a spec timing out rather than by a unit test naming it.
- **The drivers.** Everything under `tests/e2e/` needs a built app, a seeded media dir and a
  Chromium, so it is opt-in. It proves the app works.

Drivers type-check under `tests/tsconfig.e2e.json` (`bun run typecheck:e2e`) and are linted by
`bun run lint`, but `bun run test` does not execute them.

### Why selectors are centralised

`tests/e2e/contract.ts` is the one declaration of every hook a driver drives, imported by the flows
and by the guard so the two cannot disagree. No driver may spell a selector for itself: the guard
strips comments from every driver and fails a selector-shaped string literal at a selector-taking
call site. A hand-written selector rots in silence — three selector families moved at once (a
deleted `Library` tab, a colour picked by a stale `aria-label`, `.result` after the component began
rendering `.row`) while `bun test` stayed green, because nothing in the suite looked at the script.

### What a `SEL` / `HOOKS` entry means

`SEL` is how a driver ADDRESSES a hook at runtime — a CSS string (`'.band'`), a `{ role, name }`
pair for `clickByRole`, a comma union when one branch resolving is enough
(`SEL.addOrSing`, `SEL.anyTransientState`), or a function of an id (`SEL.setting`,
`SEL.settingsTab`, `SEL.swatch`).

`HOOKS` is the proof the hook still exists: `{ id, file, anchor, why }`. `file` is repo-relative,
`anchor` is a substring that must appear in that file, and `why` is what breaks without it — printed
in the guard's failure so the message names the consequence rather than the diff.

### Anchor discipline

- **File + anchor, never anchor alone.** `.brand` is rendered by two TV files, so "does any source
  carry this class" stays green when the attract screen loses it and the lobby keeps it. That is the
  exact shape of the rot the pair exists to catch.
- **Comments are stripped from the target**, so prose can never satisfy an anchor.
- **Anchor the contract the app owes a user**, not its styling: `aria-label` text, `data-testid`,
  image `alt`, or a vendored primitive's own `data-slot` (which survives a re-vendor). A
  presentational class is the weakest handle and is what rotted; an `aria-label` cannot be deleted
  without a real accessibility regression.
- **Address by class only when no literal exists to resolve.** A name built from an expression —
  `aria-label={isPlaying ? 'Pause' : 'Play'}`, `aria-label={label}`, a song title interpolated into
  the label — has no literal source text, so a `{ role, name }` entry could not match. SEL then
  takes the class and the HOOK anchors the expression, so the labels cannot be renamed unnoticed.
- **Open-ended anchors where the neighbourhood churns.** `class="row ` without its closing quote
  survives a new class in the list. A `<`-prefixed anchor (`<NowPlayingBand`) cannot be satisfied by
  a leftover import, so it keys on the component being RENDERED.
- **A control spanning two files gets two hooks.** A component rendering a class is not the app
  rendering the component: `homeReady` (`.band`) holds only because `bandMounted` composes the band
  into the sheet, which holds only because `drawerMounted` puts the sheet in the layout. Each link
  reds at the file that broke it; neither can catch the other's break.
- **Prefer an exact class token over an attribute prefix** where a family shares the prefix:
  `data-slot="empty` also matches `empty-title`/`empty-header`, so it would keep resolving after the
  Root element was deleted.
- **Re-point, do not retire, when the SUBJECT survives** and only the file moved. Mint a new id when
  the NAME carries a dead claim or the MECHANISM changed, so a reader who greps the old name lands on
  the record rather than on a selector quietly resolving against the wrong surface.

### Presence is not visibility

The now-playing sheet is mounted at all times, so every selector inside `.np-drawer` resolves cold
and a presence wait can never time out. Collapsed versus pulled-up is `activeSnapPoint`, whose values
are vaul snap VALUES (`'80px'` and `0.82`) — not an index, not a boolean. Anything measured below the
fold (geometry, contrast, a tap) is measured off a hidden element, so drag the sheet up first.
`bandTransport`, `restart` and `skip` live in the band row and need no gesture.

### The driver

`tests/e2e/driver.mjs` presents one Playwright-backed page surface that every flow imports as
`{ connect, sleep }`.

- **It launches; it does not attach.** `connectOverCDP` hangs under Bun (its ws client and Bun's
  runtime disagree), so `chromium.launch()` is the only path that works here.
- **`executablePath` comes from `findChromium()`** in `tests/e2e/lib/chromium.mjs` for the old tree; the
  new suite uses `resolveChromium()` in `tests/playwright/world/chromium.ts`. The guard that banned a second
  copy is deleted. The new resolver differs deliberately: it honours `PW_CHROMIUM` (validated, so a wrong
  path throws with the path in it), then falls back to the NEWEST cached `chromium-*` build instead of the
  exact revision Playwright asks for — the cache here holds build 1223 while the installed @playwright/test
  wants 1194, and failing on that digit with a usable browser present is not worth a ~150MB re-download.
- **No `--autoplay-policy` by default.** Flags a flow depends on are the flow's to pass through
  `opts.args`; see [Autoplay](#autoplay).
- **One browser context per phone.** Two contexts are two guests with two cookie jars, which is what
  a multi-phone flow needs; one context in two tabs is one guest.
- `goto()` polls `document.readyState === 'complete'` after the navigation: the app hydrates and THEN
  opens its WebSocket, so `load` fires well before the page can be driven.
- `newPage({ initScript })` runs a script before the app's own on every navigation — early enough to
  wrap a WebSocket opened during hydration. `setOffline` is per CONTEXT, so one guest can drop while
  the others stay up. `bypassCacheFor(pattern)` re-fetches and re-fulfils with `no-store`, because
  `/media` replies `max-age=86400` and a probe that overwrites an artifact would otherwise read
  yesterday's copy and pass.
- **Clicks go by accessible role + name** wherever a literal label exists. A flow that clicks by
  class keeps working after a control loses its accessible name, which is a regression the flow is
  supposed to surface. `clickByText` resolves the inner text node, so it misses a button whose
  content is `Label <Icon/>` — it clicks nothing, reports nothing, and every downstream wait then
  times out on a perfectly current selector.

### Gestures

A synthetic `el.click()` is an UNTRUSTED event and grants no user activation, so it can neither
unblock autoplay nor resume an `AudioContext`. Use `realClick(x, y)` for hit-testing what is actually
on top, and `drag()` — a stepped pointer sequence, `down`, N `move`s, `up` — wherever a handler reads
intermediate moves. A teleporting pointer, or a synthetic click, proves nothing about either.

### Shared helpers

Each of these exists because the knowledge it holds moved and cost N driver edits the last time it
was inlined.

| Module                        | Holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/e2e/lib/join.mjs`      | how joining works. `/` is a two-pane screen: with `?room=CODE` a guest lands on the identity pane, without one on the six-box code pane — and the name field is only on the identity pane, so a bare `goto('/')` plus a fill of the name input times out. Drivers take the scanned path, reading the code off the TV's attract panel (`SEL.attractCode`), because no endpoint publishes it and the QR hides it in a data URL. Cached per base URL; pass `fresh: true` after restarting a server. |
| `tests/e2e/lib/phone.mjs`     | the phone's post-join step. Search has been docked on `/`, then its own `/find` route, and is a field at the top of `/` again; ~20 call sites go through `openBrowseFromHome` so each move costs one file.                                                                                                                                                                                                                                                                                       |
| `tests/e2e/lib/chromium.mjs`  | `findChromium()`. PW_CHROMIUM is VALIDATED, not trusted: a set-but-wrong path returns null so the caller bails loudly instead of surfacing as a launch failure.                                                                                                                                                                                                                                                                                                                                  |
| `tests/e2e/lib/child.mjs`     | `spawnChild` (piped stdio) and `killChild` (SIGTERM escalating to SIGKILL, polled, no-op on an exited child so a `finally` can call it unconditionally).                                                                                                                                                                                                                                                                                                                                         |
| `tests/e2e/lib/repo-root.mjs` | the repo root, found by walking up for `bunfig.toml` rather than counting `..` hops. Hop-counting encodes a file's distance from the root and broke for six probes when the tree moved under `tests/`. A plain relative import, because drivers run under bare `bun run` where the `@encore/test-support` alias does not resolve.                                                                                                                                                                |

### Reachability

`tests/guards/meta/e2e-reachability.test.ts` used to require every `.mjs`/`.ts` under `tests/e2e/` to be
reachable from a `package.json` script, or on a closed `UNRUN` list with its reason. It is deleted along with
the rest of `tests/guards/`. Playwright makes the rule structural instead of asserted: a spec under
`tests/playwright/specs/<project>/` is discovered by its project, so there is no manifest to drift from — but
equally, nothing now notices a spec file that no project's `testDir` covers.

Reachability is **by name**, not only by import: the walk starts from files a script mentions and
follows any other file's basename appearing anywhere in the text. That is deliberate — drivers spawn
each other by path string (`fake-stems-worker.mjs` is launched, never imported), so a static import
graph would report live files dead. The cost is that a passing English word or a comment can make a
file "reachable" by accident. **A probe is reachable when `tests/e2e/run-probes.mjs` lists its full
path in `PROBES`**, which is also what makes it discoverable and runnable in one step; anything else
is luck.

Each `PROBES` entry carries a `mode`:

- **boots** — spawns its own server, worker and Chromium and cleans up after itself.
- **serves** — expects `EPORT` to name a running server. The runner boots a FRESH seeded ephemeral
  one per probe, not one shared across the group: several of these assert on a pristine room and
  report a false or environmental finding when run after a probe that joined singers.
- **tool** — takes arguments and answers a question. Listed so it is discoverable, excluded from
  `all` because no default argument would mean anything.

The runner passes both `EPORT` and `PORT`, because the probes disagree on which one names the port
and passing only `EPORT` left one dialling a hardcoded default, getting `ERR_CONNECTION_REFUSED`, and
exiting 0.

Not part of `bun run gates`: these drive a real browser and take minutes. Reachability and gate
membership are different things.

### Exit codes, and what `ran` means

`0` every finding passed · `1` a real failure · `2` the environment could not host the test.
**Never conflate 2 with 0** — a skipped audio test reporting green is how the no-sound hole stayed
open for as long as it did. A probe that cannot reach the app must FAIL rather than report success.

In the runner's summary, `ran` is not `passed`: capture drivers gather evidence and exit 0 whatever
they saw, so their output is the verdict and their exit code is not.

### Proving audio

`paused === false` proves nothing — an element reports it while stuck at `currentTime` 0 behind a
failed decode, because `paused` reports INTENT. `readyState === 4` only says bytes arrived. The proof
is **`webkitAudioDecodedByteCount` climbing**, corroborated by `currentTime` advancing against the
wall clock. That distinction IS the FLAC-in-a-`<video>` defect: valid file, element "playing", zero
decoded bytes, silent room.

The fixture is hand-emitted, not encoded: `tests/e2e/wav.mjs` writes 16-bit PCM WAV by hand
(`tone()` for audible audio, `silence()` for the digital-silence floor a guard must refuse), because
both ffmpeg builds on this box are decode-only and there is no flac/sox/lame. `tests/e2e/seed-media.mjs`
emits the same real WAV through `world/seed.mjs`, so a seeded library track is decodable and playable —
it no longer writes the 16-byte ISO-BMFF placeholders it once did, because core now refuses to index a
library file whose duration it cannot read (see "The demo library"). A seeded track is still not a
PROCESSED one: stems and lyrics come from `tests/e2e/fake-stems-worker.mjs` claiming a job and
publishing real audio, so a READY song still needs it.

### Autoplay

Granting `--autoplay-policy=no-user-gesture-required` proves playback in an environment no television
is ever in. Measured on one real processed song: gestureless leaves `paused true`, `currentTime 0.00`
and 24576 decoded bytes (the preload burst, and nothing more); with the flag, `paused false`,
`currentTime 5.41`, 507904 bytes.

So **assert playback gestureless**. A probe that must grant the flag — because its subject is a
playhead that has to already be moving — labels its output `NOT-A-TV`, and says nothing about whether
a real television starts on its own.

## The probes and the gates

### Gates

`bun run gate:measured` (`tests/e2e/gates/measured-design.mjs`) is the exception to everything above:
it is the seventh leg of `bun run gates`, run by every lane, and it measures the four design claims a
source scan cannot decide — control hit extents against `--tap` at three viewports, computed field
font sizes, `--dock-h` against the docked row's real height plus the safe-area term, and the painted
`:focus-visible` ring.

Its rules:

- **It boots its own world** — own free port, own seeded media dir, own Chromium, all torn down on
  exit. A probe may expect a server; a gate cannot.
- **There is no exit 2.** A missing Chromium, an unbuilt app and a server that will not answer
  `/health` are all exit **1**, with the remedy printed. A permanently-skipped check is
  indistinguishable from the rot it was meant to catch.
- **It measures a resolved layout**, so `bun run build` must have run first. None of the four claims
  is decidable without a real layout engine, which is why they live in a browser at all. The mount rung
  that used to enforce this (`tests/setup/svelte-dom-preload.ts`, which replaced `getBoundingClientRect`
  with a throw naming the rung) is deleted, so the prohibition is now a convention rather than a mechanism.
- **Take a hit extent at the CENTRE x.** Chromium hit-tests `border-radius`, so sweeping at a
  far-edge x measures the chord through the control's own rounded corner and read every 44px pill as
  34–42px. Use far-edge probes for occlusion only, along the widest row.
- **Accept a hit as the control's own only when `hit === el || el.contains(hit)`** — never the
  reverse, which counts `<body>` as a hit and inflated a 32px target to 93px.
- **`scrollIntoView({ block: 'center' })` before hit-testing**: `elementFromPoint` returns null
  outside the viewport, so an un-scrolled control measures 0 and reads as catastrophic. A control
  behind an open modal legitimately measures 0, so the home route is measured with the sheet
  collapsed and the sheet's own geometry separately.
- **Headless has no notch.** Every `env(safe-area-inset-*)` resolves to 0, so
  `calc(10px + env(safe-area-inset-bottom, 0px))` and a bare `10px` measure identically and an arm
  comparing them proves nothing. `page.safeAreaInsets({ bottom: 34 })` is what makes that arm real.

`tests/e2e/gates/measured-design-register.mjs` is the data half — the control register, the tap floor
read live out of `--tap`, and a QUARANTINE of control classes that already measured under the floor
when the gate was first run. The register WAS loaded by `tests/guards/wiring/measured-design-gate.test.ts`, which ran in `bun run test`
on every box and asserted the register is non-vacuous, that every quarantine entry carries a substantive
reason, and that the gate is still in the gate list. That guard is deleted, which removes exactly the
protection its own rationale named — a register only the gate can read is a register nobody checks when the
gate does not run, and that is now the state. Re-establishing it as a plain `tests/unit/` test is the
cheapest way back, since `tests/helpers.ts` still exports the `read`/`stripComments` it needs. The gate fails
when a quarantined control **improves** to the floor as well as when it regresses: a quarantine entry
whose defect no longer reproduces is a guard that can no longer fail, and on a real browser it may
only mean this box ships a different UA default. Either way the entry gets re-decided, never nudged.

### Probes

Mode is from `PROBES` in `tests/e2e/run-probes.mjs`. `captures` drivers gather evidence and exit 0
whatever they saw.

| Probe                                          | Mode              | The one thing it proves                                                                                                                                                                                    |
| ---------------------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/e2e/probes/p1-gapless.mjs`              | serves            | song 2 starts with no human touch, the seam between the TV's two `<audio>` slots is bounded, and the two never decode at once                                                                              |
| `tests/e2e/probes/p2-guiding-track.mjs`        | boots             | the original vocals mix back under the instrumental at the room default / per-song override / explicit off, held in time by the governor                                                                   |
| `tests/e2e/probes/p3-key-shift.mjs`            | serves            | the browser pitch shifter is WIRED into the graph and moves the dominant partial by exactly 2^(N/12) — not silenced, not unshifted                                                                         |
| `tests/e2e/probes/p4-transport.mjs`            | serves            | play/pause/skip/restart and `seek` move the master element, and the server's `positionSec` tracks the TV instead of pinning at 0                                                                           |
| `tests/e2e/probes/p5-process-lifecycle.mjs`    | boots             | the unhappy process paths (silent stem, unwritten ref, no profile, failure, retry) reach a phone/TV/library surface honestly                                                                               |
| `tests/e2e/probes/p6-lyrics.mjs`               | serves            | the word-timed reel appears with no reload, tracks the audio clock, and obeys live presentation settings — including against a fixture the probe rewrites itself                                           |
| `tests/e2e/probes/p8-presence-resilience.mjs`  | serves            | ten phones stay in sync across disconnects, a duplicate-name rejection recovers, and a leave does not abandon queued songs                                                                                 |
| `tests/e2e/probes/p9-settings.mjs`             | serves            | a settings change sticks in SQLite, fans out over `settings:changed`, and reaches the workers at assign time — otherwise it is a slider that does nothing                                                  |
| `tests/e2e/probes/p10-scaling.mjs`             | serves (captures) | the TV scales UP as well as down, the remote survives 320px, and measured contrast clears WCAG AA on real computed colours                                                                                 |
| `tests/e2e/probes/p11-dashboards.mjs`          | boots             | `/stats`, `/metrics` and the per-song audit agree with counts the probe made itself, rather than showing zeros, NaN or a stale total. Owns its port exclusively and bails if anything is already listening |
| `tests/e2e/probes/p12-search.mjs`              | serves            | one search box partitions every source on the readiness axis, transitions live over the WebSocket, and survives adversarial queries                                                                        |
| `tests/e2e/probes/p13-tap-to-start.mjs`        | serves            | the only route out of a silent television works — the document-wide listener plus the full-screen hint, driven gesturelessly                                                                               |
| `tests/e2e/probes/p14-playhead-vs-process.mjs` | boots             | processing a DIFFERENT song never steps the playing song's playhead backwards (`NOT-A-TV`: grants autoplay)                                                                                                |
| `tests/e2e/probes/p15-reload-resume.mjs`       | boots             | a mid-song TV reload resumes at the room position and does not drag the server's position backwards (`NOT-A-TV`)                                                                                           |
| `tests/e2e/probes/p15-phone-reflow.mjs`        | boots             | every phone surface reflows at 320px with the root font-size doubled — `scrollWidth <= clientWidth`, naming the offending element. Needs a built UI                                                        |
| `tests/e2e/probes/p16-hero-live-controls.mjs`  | boots             | the now-playing drawer's live controls work, degrade honestly when a track is dead, and its sliders do not dismiss the sheet                                                                               |
| `tests/e2e/probes/lower-third.mjs`             | serves            | the wall names the singer of whichever src the AUDIBLE element carries, sampled from the audio rather than from a decode counter                                                                           |
| `tests/e2e/probes/tv-audiocontext-resume.mjs`  | serves            | the TV's AudioContext state under both autoplay policies side by side — the A/B that tells a suspended context from a broken shifter                                                                       |
| `tests/e2e/probes/tv-scrim-empty-lobby.mjs`    | serves            | the tap-to-start scrim does not outlive the room: nothing is painted over the join card of a drained lobby                                                                                                 |
| `tests/e2e/probes/admin-delete.mjs`            | serves (captures) | `/admin`'s two-step delete posture, shot at the list and at the armed confirm                                                                                                                              |
| `tests/e2e/probes/preflight-reset-audit.mjs`   | tool              | every property Tailwind's Preflight resets, on every element of every reachable surface, into a JSON audit                                                                                                 |
| `tests/e2e/probes/preflight-diff.mjs`          | tool              | two audits differ or do not — and refuses to compare surfaces whose tag sequence disagrees, because the failure mode of this measurement is a FALSE difference                                             |

### The flows outside `probes/`

| Driver                                                                            | Proves / produces                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/e2e/party.mjs` (`bun run e2e`)                                             | the full room: two phones and a TV, join through search, queue, rotation and skip, driven by accessible name. Needs an EMPTY room and a ROUTABLE advertised origin — a loopback origin renders the unreachable-QR notice instead of the type the first checks read |
| `tests/e2e/playback.mjs`                                                          | a sound actually comes out, by the decoded-byte rule above                                                                                                                                                                                                         |
| `tests/e2e/fuzz.mjs` (`bun run e2e:fuzz`)                                         | the six invariants below, re-evaluated after EVERY input from a seeded PRNG, because the live defects were in the ADJACENCY of inputs that no curated sequence covers. `FUZZ_SEED` replays a run input for input                                                   |
| `tests/e2e/lobby-overlap.mjs` (`bun run e2e:lobby`)                               | on a short TV panel the lobby's typed join address is never intersected or painted over by the roster strip, measured by rect AND `elementFromPoint`                                                                                                               |
| `tests/e2e/capture.mjs`                                                           | every UI surface driven INTO each state rather than photographed as it loads. The TV is shot at 1920x1080 because its type scale is vh-relative                                                                                                                    |
| `tests/e2e/shoot.mjs`                                                             | before/after evidence for a deliberate visual change. Deliberately in no gate list: a screenshot cannot fail a build                                                                                                                                               |
| `tests/e2e/shot.mjs`, `tests/e2e/shot-settings.mjs`, `tests/e2e/shot-metrics.mjs` | one-off frames. `shot-metrics` stubs `/api/metrics` through an `initScript`, so its numbers are fixture data and the frames are for wording only                                                                                                                   |

### The fuzz invariants

Each is re-evaluated after every single input, never once at the end. I2/I3/I5 are cross-surface and
therefore asynchronous by design, so they are retried against fresh snapshots until they hold or the
budget runs out; I1/I4/I6 are single-surface and read once.

|     | Holds that                                                                                                                                                                                   |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| I1  | `currentTime` is monotonic within a song; it may fall only across a seek, restart or entry change                                                                                            |
| I2  | exactly one queue entry is `playing` — not zero while the TV renders a song, not two                                                                                                         |
| I3  | the TV's RENDERED now-playing equals the SERVER's `currentEntryId`, read off the server's own socket rather than from another client's guess                                                 |
| I4  | the lyrics active index is consistent with `currentTime` — the active line's window contains it                                                                                              |
| I5  | no entry is both `playing` and waiting, and the phones' rendered rotation agrees with the server's waiting set                                                                               |
| I6  | `webkitAudioDecodedByteCount` CLIMBS whenever the UI claims to be playing, sampled twice 1.5s apart. The one that cannot be dropped: a run that never evaluated it exits 2 rather than green |

### Fuzzing the room

`bun run e2e:fuzz` boots its own private room on a free port; `EPORT=<port>` drives an already-running one
and owns nothing it found. The knobs:

| Env                | Does                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `FUZZ_SEED=123456` | replay a run input for input. Every random decision goes through the seeded PRNG                            |
| `FUZZ_INPUTS=24`   | how many inputs after the opening add. Tens, not thousands — a human must replay it                         |
| `FUZZ_AUTOPLAY=1`  | grant autoplay, and print the literal token NOT-A-TV beside the seed                                        |
| `FUZZ_PORT=5401`   | host the private room here instead. Bind-tested, so a stranger's Encore on it is refused rather than driven |

Gestureless is the default, so the one real tap is delivered by `realClick` and nothing more. The honest
consequence, printed in the summary: before that tap the browser refuses autoplay, so I1/I4/I6 report
SKIPPED with that reason named rather than passing vacuously.

**Where a control has no contract entry the fuzzer does not inline a selector.** The gap is reported on
stderr at startup and the input goes out as the WIRE COMMAND the control would have sent, from the phone's
own authenticated socket, which is the same server path. That covers `seek` (no UI control exists at all),
the key-shift caps, the guiding-track slider and the per-row remove.

`back` is not driven at all — no PlayerCommand, no control, and no previous-entry concept in the server — so
`restart` stands in for it and the seam is labelled RESTART-THEN-PAUSE in the output, so nobody reads it as
evidence about a back button.

### Fault injection

Env vars on `tests/e2e/fake-stems-worker.mjs`, which is how every unhappy path is reached.

| Env                          | Injects                                                                                                                                                                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FAKE_SILENT_INSTRUMENTAL=1` | floor-level instrumental — the guard must refuse to publish it                                                                                                                                                                                                                |
| `FAKE_SILENT_VOCALS=1`       | floor-level vocals — must NOT fail the process; the guide track is optional                                                                                                                                                                                                   |
| `FAKE_SKIP_WRITE=1`          | a ref reported for a file never written — the unservable path                                                                                                                                                                                                                 |
| `FAKE_NO_PROFILE=1`          | completion with no `songProfile` — the gate must not deadlock                                                                                                                                                                                                                 |
| `FAKE_FAIL=stems`            | fail that job type instead of completing it                                                                                                                                                                                                                                   |
| `FAKE_SLOW_MS=1500`          | dwell between progress frames, to watch the processing UI                                                                                                                                                                                                                     |
| `FAKE_NO_VOCALS=1`           | no vocals ref at all — a real state, not a fault: a worker that could not encode vocals reports none and the song stays playable. NOT what disables the guiding track                                                                                                         |
| `FAKE_GUIDE_MIX=1`           | publish the 4-channel guide MIX. `hasGuidingTrack()` reads `guideMixRef`, not the vocals stem, and this worker publishes no mix by default — so this flag is the only way to reach the ENABLED arm of the slider. Opt-in, so existing probes keep exercising the degraded one |

Singer names are unique per room: reusing one gets a 409 and the join page simply stays put, which
looks exactly like a broken flow. Use a fresh name per probe.

## The demo library

`tests/e2e/world/seed.mjs` owns the demo fixture: four filenames, their tone, and the writer that puts
them under `MEDIA_DIR/library`. `bun run e2e:seed` is a thin wrapper around it.

It used to live in two halves — `server.ts` held the titles, artists and durations while `seed-media.mjs`
held the filenames — and the seeder's own header admitted the hazard: *"Must match the seededLibrary
sourceRefs in server.ts. NOT covered by the contract guard … so nothing reds if they drift apart."*
Three things were wrong with that arrangement, and all three are fixed:

- **It ran in production.** The seed had no environment guard, so every box — including a real
  deployment — wrote three YouTube rows (`demo-takeonme`, `demo-mrbrightside`, `demo-dancingqueen`) and
  four local tracks into its catalog on every boot.
- **It was the ONLY thing in the local library.** `LocalLibrary`'s comment claimed it "scans a media
  directory" and was "rebuilt from disk scan on boot", but nothing scanned: `index()` had exactly one
  caller, in `server.ts`, with that hardcoded list. A deployment that dropped real files into
  `MEDIA_DIR/library` indexed none of them. The `local library scan` boot pass in `app.ts` is the scan
  the comment always described.
- **The files were not decodable.** The seeder wrote 16-byte ISO-BMFF headers and said so: *"these are
  NOT decodable media — indexing/queueing only, never playback or processing"*. They are real 8-second
  WAV tones now, by way of `wav.mjs`. This is no longer optional: core reads a duration with ffmpeg
  before indexing a library file and **skips** any file it cannot measure, because a track indexed at
  `durationSec: 0` is one the wait estimate reports as instant. Their 8 seconds is a fixture value.

The filename is the only metadata a library track has — `trackNameFromFile` splits `Artist - Title.ext`
on a spaced hyphen and treats anything else as all-title. The fixture keeps kebab-case names so probes
can match a stable substring (`sourceRef.includes('sweet-caroline')`).

`/harness` and `/harness/phone` are likewise opt-in now, behind `ENCORE_DEV_HARNESS=1`: they are
unauthenticated pages that mint queue commands, so they are a tool you ask for rather than a surface
that is simply there. Their three buttons were hardcoded to the demo ids and are now built from
`/api/library`.

## If this tree were rewritten: use `@playwright/test`

Recorded as a decision not yet executed, so the reasoning is not re-derived. `@playwright/test` is
**already a devDependency**, and `driver.mjs` is a 250-line facade over it exposing `connect` and
`sleep`. Everything else the framework provides is hand-rolled across ~30 entry points:

| Concern                | Files re-implementing it | What replaces it |
| ---------------------- | ----------------------- | ---------------- |
| `bail()`               | 17                      | `test.skip()` / a failed fixture |
| `check()`              | 10                      | `expect` |
| `EPORT` parsing        | 31                      | a worker-scoped fixture, or `webServer` |
| `waitFor`              | 31                      | auto-waiting + `expect.poll` |
| its own `/health` poll | 28                      | `webServer.url` |
| scratch-dir handling   | 21                      | `testInfo.outputDir` |
| spawning a server      | 14                      | one fixture |
| `run-probes.mjs`       | 371 lines of runner     | `--project=probe` |

The five screenshot tools differ on only two axes — who owns the server, and which frames — so they
collapse into one table-driven spec, with `toHaveScreenshot()` doing natively what `shoot.mjs` does by
hand:

| File                  | Lines | Server           | Frames |
| --------------------- | ----- | ---------------- | ------ |
| `shot.mjs`            | 23    | already running  | 1, from argv |
| `shot-settings.mjs`   | 81    | already running  | the 3 settings tabs |
| `shot-metrics.mjs`    | 200   | already running  | `/metrics`, `fetch` stubbed |
| `shoot.mjs`           | 249   | boots its own    | 4 migration surfaces |
| `capture.mjs`         | 556   | running + seeded | ~30 |

Target shape:

```
tests/e2e/
  playwright.config.ts        projects: gate | flow | probe | shot
  world/{fixtures,seed,audio,workers,selectors}.ts
  specs/gate/measured-design.spec.ts
  specs/flow/{party,playback,lobby,fuzz}.spec.ts
  specs/probe/p1-gapless.spec.ts …
  specs/shot/frames.spec.ts
```

Two constraints on doing it, both learned the hard way:

- **`gates/measured-design.mjs` moves LAST, on its own.** It is gate leg 7, it is 1,125 lines, and it
  encodes methodology paid for in bugs — take a control's extent at the CENTRE x because Chromium
  hit-tests `border-radius`, and shoot at DPR 1 because the frames get read back. Its assertions move
  one-for-one or not at all.
- **A probe's assertions are moved, never rewritten.** The 20 probes carry real domain knowledge, and a
  mechanical translation is how a suite silently weakens.

The migration also erases most of the 194 `noUncheckedIndexedAccess` errors that `tests/tsconfig.e2e.json`
currently opts out of, because specs become real `.ts` in a real program — and it retires that config's
hand-maintained 40-file `include` list in favour of Playwright's own discovery.
