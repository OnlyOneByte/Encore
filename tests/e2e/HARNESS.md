# The E2E harness — how to make a real party happen on a box with no ML

Read this before writing a probe. It exists because the previous suite could drive join → search →
queue → rotation and still never prove a sound came out, and every audio defect the real party hit
lived in exactly that gap.

## What was missing, and what closed it

`seed-media.mjs` writes 16-byte ISO-BMFF stubs. Its own header says they are "NOT enough to decode,
so do not use this to test playback". So there was no audio in the fixture to assert about.

Two files close that:

| File | What it does |
|---|---|
| `wav.mjs` | Emits real 16-bit PCM WAV by hand — `tone()` for audible audio, `silence()` for the digital-silence floor a guard must refuse. No encoder needed. |
| `fake-stems-worker.mjs` | Dials home like the Python worker, claims real `fetch`/`stems`/`align` jobs, and publishes real audio. Runs the whole core-side process path. |

**Why emit instead of encode.** Both ffmpeg builds on this host are decode-only — no muxers, no
encoders, no `lavfi`, not even the `volumedetect` filter the loudness probe shells out to — and there
is no flac/sox/lame. A RIFF header is 44 documented bytes and s16le samples are integers, so a WAV can
be written with zero dependencies, and `wav: 'audio/wav'` is already in the media route's
content-type map. Chromium decodes it natively.

## What a green run does and does not prove

Proves: the core's wire contract, the storage layout, the readiness gates, byte-range serving, and the
browser's decode path.

Does **not** prove: separation quality, alignment accuracy, that yt-dlp can still reach YouTube, or
how anything *sounds*. Say which you mean when you report.

## Environment on this box

| Tool | State | Consequence |
|---|---|---|
| bun, node, Chromium | present | full browser driving works |
| yt-dlp | present | YouTube **search** works |
| **deno** | **present, 2.4.0** | YouTube **download** works — the player challenge needs a JS runtime and this is it. Verified: `[youtube] [jsc:deno] Solving JS challenges using deno`, real Opus fetched. **Do not upgrade past 2.4.0**: yt-dlp needs `deno >= 2.3.0`, but deno's aarch64 builds from 2.4.5 up require `GLIBC_2.27` and this box has 2.26, so `deno@latest` will not execute at all. Fallback runtimes: node 22.22.3 (at `$HOME/.local/share/mise/installs/node/22.22.3/bin`, not deprecated — name the 22.x path, the default shim is v20.20.2 and silently degrades), then bun 1.3.14 (works, deprecated upstream). |
| **ffmpeg** | **decode-only** | no encoding, and the loudness probe's `volumedetect` filter is absent |
| torch / demucs / whisperx | missing | no real separation or alignment — use the fake worker |

## The one driver that is a GATE, not a probe

`e2e/gates/measured-design.mjs` is the exception to everything below. Everything in `e2e/probes/` is
run by an agent that decides to; that file is **the fifth gate**, run by every lane with

```bash
bun run gate:measured          # from the repo root, AFTER bun run build
```

Three ways it differs from a probe, all deliberate:

- **It boots its own world.** Its own free port, its own seeded media directory, its own Chromium, all
  torn down on exit. A probe expects you to have started a server; a gate cannot.
- **There is no exit 2.** A missing Chromium, an unbuilt app and a server that will not answer
  `/health` are all exit **1**, with the remedy printed. Owner ruling Q1 chose this over
  skipping, because `contract.test.ts:23` had already ruled a permanently-skipped test
  indistinguishable from the rot it was meant to catch.
- **It measures rather than drives.** It reads what a real layout engine resolved: hit extents against
  `--tap`, computed field font sizes, the drawer's cap against `innerHeight`, `env(safe-area-inset-*)`
  under a simulated inset, and the painted focus ring. `src/lib/measured-design-gate.test.ts`
  is its always-on half — it runs in `bun test` on every box and asserts the gate stays wired.

Two methodology notes it paid for, beyond the ones in `docs/ux/04-verification.md`:

- **Chromium hit-tests `border-radius`.** Sweeping a control's vertical extent at a far-edge x measures
  the chord through its own rounded corner, so every 44px pill read 34–42px and the floor was
  unmeetable by construction. Take the extent at the CENTRE x; use the far-edge probes for occlusion
  only, along the control's widest row.
- **Headless has no notch.** Every `env(safe-area-inset-*)` resolves to 0, so
  `calc(10px + env(safe-area-inset-bottom, 0px))` and a bare `10px` measure identically and a guard
  comparing them proves nothing. `page.safeAreaInsets({ bottom: 34 })` is what makes that arm real —
  the helper #827's spike added to `driver.mjs`, which this gate consumes rather than adding a second copy
  of. Two identical helpers under two names on the shared driver is the drift `lib/chromium.mjs`'s
  single-source rule exists to prevent.

## Boot a private instance

Every probe gets its own port and media dir, so runs never collide.

```bash
cd .
PORT=52NN                      # yours alone
SCRATCH=$KIROCREW_SCRATCH/e2e-$PORT
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/media"

MEDIA_DIR="$SCRATCH/media" bun run tests/e2e/seed-media.mjs      # 4 demo tracks become indexable

ENCORE_EPHEMERAL=1 PORT=$PORT HOST=127.0.0.1 MEDIA_DIR="$SCRATCH/media" \
  ENCORE_LYRICS_BACKFILL=0 ENCORE_VOCALS_BACKFILL=0 \
  nohup bun run ./server.ts > "$SCRATCH/server.log" 2>&1 &

until curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; do sleep 0.5; done

EPORT=$PORT MEDIA_DIR="$SCRATCH/media" nohup bun tests/e2e/fake-stems-worker.mjs > "$SCRATCH/worker.log" 2>&1 &
```

`bun run build` must have run once for the UI to exist; the server warns loudly if it has not.

## Process a song so there is something to sing

```bash
curl -s -c "$SCRATCH/jar" -X POST "http://127.0.0.1:$PORT/api/join" \
  -H 'content-type: application/json' -d '{"displayName":"Probe","color":"#ff5cae"}'

MID=$(curl -s "http://127.0.0.1:$PORT/api/search?q=caroline" \
  | bun -e 'const d=await Bun.stdin.json();
            console.log([...d.ready,...d.results].find(x=>x.source==="local").id)')

curl -s -b "$SCRATCH/jar" -X POST "http://127.0.0.1:$PORT/api/process" \
  -H 'content-type: application/json' -d "{\"mediaId\":\"$MID\"}"
```

The `stems` job chains an `align` job automatically, so a few seconds later the song is ready with a
real instrumental, a real vocals stem, a song profile and word-level lyrics.

**Singer names are unique per room.** Reusing one gets a 409 and the join page simply stays put, which
looks exactly like a broken flow. Use a fresh name per probe.

## Fault injection

The interesting defects are all in the unhappy paths. Set these on `fake-stems-worker.mjs`:

| Env | Injects |
|---|---|
| `FAKE_SILENT_INSTRUMENTAL=1` | floor-level instrumental — the guard must refuse to publish it |
| `FAKE_SILENT_VOCALS=1` | floor-level vocals — must **not** fail the process, the guide track is optional |
| `FAKE_SKIP_WRITE=1` | a ref reported for a file never written — the unservable path |
| `FAKE_NO_PROFILE=1` | completion with no `songProfile` — the gate must not deadlock |
| `FAKE_FAIL=stems` | fail that job type instead of completing |
| `FAKE_SLOW_MS=1500` | dwell between progress frames, to watch the processing UI |

## Asserting on audio

`paused === false` is **not** proof: an element reports that while stuck at `currentTime` 0 behind a
failed decode. `readyState === 4` only says bytes arrived. The proof is
**`webkitAudioDecodedByteCount` climbing**, corroborated by `currentTime` advancing against the wall
clock. That distinction *is* the FLAC-in-a-`<video>` defect: valid file, element "playing", zero
decoded bytes, silent room.

`playback.mjs` is the worked example.

**Autoplay is the trap this harness fell into, so read this before copying a launch flag.** Granting
`--autoplay-policy=no-user-gesture-required` proves playback in an environment **no television is
ever in**. Measured side by side on a real processed song:

| Launch | paused | currentTime | decoded bytes |
|---|---|---|---|
| gestureless (a real TV) | `true` | `0.00` | `24576` — the preload buffer, and nothing more. It never plays. |
| autoplay granted | `false` | `5.41` | `507904` |

So a run made with the flag cannot support a claim about whether the room makes a sound; it can only
support a claim about the decode path once something has started. **Assert playback gestureless**, and
if you do grant the flag, label that probe's output `NOT-A-TV` so the next reader cannot mistake it for
evidence about a real television. `tv-audiocontext-resume.mjs` runs both policies side by side and is the
reference for this.

## Writing a probe

Put it at `e2e/probes/<your-id>.mjs` so parallel authors never touch the same file. Import `connect`
and `sleep` from `../driver.mjs` and every selector from `../contract.ts` — never hand-write a selector,
because `contract.test.ts` guards those against the source and a hand-written one rots silently.

Exit codes: `0` all passed, `1` a real failure, `2` the environment could not host the test. Never
conflate 2 with 0 — a skipped audio test reporting green is how this hole stayed open.

## Running the probes: `bun run e2e:probes`

Every driver in this tree is reachable from one command. `bun run e2e:probes` with no argument lists
them with their mode and subject; pass a name to run one, or `all` / `boots` / `serves` for a group.

Three modes, because the drivers genuinely differ:

- **boots** — the probe spawns its own server and worker and cleans up after itself.
- **serves** — the probe expects `EPORT` to name a running server. The runner boots one shared,
  seeded, ephemeral server for the group, spawns a fake stems worker, and drives one library song to
  READY, because that is the fixture several of them ask for and `seed-media.mjs` alone cannot supply
  (it writes placeholder files — enough to index and queue, not to process).
- **tool** — takes arguments and answers a question. Listed so it is discoverable, excluded from
  `all` because no default argument would mean anything.

**It is not part of `bun run gates`, deliberately.** These drive a real browser and take minutes.
Reachability and gate membership are different things.

`ran` in the summary is not `passed`. Three drivers gather EVIDENCE rather than assert an invariant —
they write screenshots or a `findings.json` and exit 0 whatever they saw. Read their output.

### State as of the first full run

These sat unexecuted long enough to go stale, which is exactly what an unrun list buys you. Recorded
so the next person starts from data rather than from scratch.

| Driver | State |
|---|---|
| `p14-playhead-vs-process` | **passes** — playhead never stepped back, worst delta 0.000s |
| `p15-phone-reflow` | **passes** 4/4 — needs a built UI, the runner checks for one |
| `p16-hero-live-controls` | **passes** 11/11 |
| `p5-process-lifecycle` | **runs, and reports a real `[HIGH]` finding**: a floor-level silent instrumental is published as READY with no defence-in-depth in the core. This is the probe doing its job — treat it as a product defect, not a broken probe. |
| `p15-reload-resume` | environment bail: server position never passes 3s, so there is no resume to test |
| `p10-scaling`, `admin-delete-639`, `shoot-913` | capture only; `p10` recorded 12 phases of which 7 were `remote-*` timeouts |
| `p2-guiding-track`, `tv-audiocontext-resume` | boot and process fine, then time out filling the join name input. The selector and its placeholder both still exist, so this is page state, not a stale selector |
| `tv-scrim-empty-lobby-736` | opens `/` in a fresh browser and expects home; a browser with no session gets the join landing, so `.search-dock` never appears. The probe never joins |
| `p8-presence-resilience` | carries its OWN hand-rolled CDP client, which the Playwright port left behind — it dials a debug port that no longer exists |
| `p1-gapless`, `p3-key-shift`, `p6-lyrics`, `p9-settings` | fail on queue/UI preconditions; each needs its own read |

Two things worth knowing before touching any of them. The probes do not agree on which variable names
the port: most read `EPORT`, two read `EPORT ?? PORT`, and `p10-scaling` reads `PORT` alone — the
runner passes both, and passing only `EPORT` is what left `p10` dialling its own hardcoded 5230, where
it got `ERR_CONNECTION_REFUSED` and still exited 0. And a probe that cannot reach the app must fail;
if you find one reporting success from an unreachable server, that is the bug, not the symptom.
