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
| `fake-stems-worker.mjs` | Dials home like the Python worker, claims real `fetch`/`stems`/`align` jobs, and publishes real audio. Runs the whole core-side cook path. |

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

## Boot a private instance

Every probe gets its own port and media dir, so runs never collide.

```bash
cd apps/core
PORT=52NN                      # yours alone
SCRATCH=$KIROCREW_SCRATCH/e2e-$PORT
rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/media"

MEDIA_DIR="$SCRATCH/media" bun run e2e/seed-media.mjs      # 4 demo tracks become indexable

ENCORE_EPHEMERAL=1 PORT=$PORT HOST=127.0.0.1 MEDIA_DIR="$SCRATCH/media" \
  ENCORE_LYRICS_BACKFILL=0 ENCORE_VOCALS_BACKFILL=0 \
  nohup bun run ./server.ts > "$SCRATCH/server.log" 2>&1 &

until curl -sf "http://127.0.0.1:$PORT/health" >/dev/null; do sleep 0.5; done

EPORT=$PORT MEDIA_DIR="$SCRATCH/media" nohup bun e2e/fake-stems-worker.mjs > "$SCRATCH/worker.log" 2>&1 &
```

`bun run build` must have run once for the UI to exist; the server warns loudly if it has not.

## Cook a song so there is something to sing

```bash
curl -s -c "$SCRATCH/jar" -X POST "http://127.0.0.1:$PORT/api/join" \
  -H 'content-type: application/json' -d '{"displayName":"Probe","color":"#ff5cae"}'

MID=$(curl -s "http://127.0.0.1:$PORT/api/search?q=caroline" \
  | bun -e 'const d=await Bun.stdin.json();
            console.log([...d.ready,...d.results].find(x=>x.source==="local").id)')

curl -s -b "$SCRATCH/jar" -X POST "http://127.0.0.1:$PORT/api/make-karaoke" \
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
| `FAKE_SILENT_VOCALS=1` | floor-level vocals — must **not** fail the cook, the guide track is optional |
| `FAKE_SKIP_WRITE=1` | a ref reported for a file never written — the unservable path |
| `FAKE_NO_PROFILE=1` | completion with no `songProfile` — the gate must not deadlock |
| `FAKE_FAIL=stems` | fail that job type instead of completing |
| `FAKE_SLOW_MS=1500` | dwell between progress frames, to watch the cooking UI |

## Asserting on audio

`paused === false` is **not** proof: an element reports that while stuck at `currentTime` 0 behind a
failed decode. `readyState === 4` only says bytes arrived. The proof is
**`webkitAudioDecodedByteCount` climbing**, corroborated by `currentTime` advancing against the wall
clock. That distinction *is* the FLAC-in-a-`<video>` defect: valid file, element "playing", zero
decoded bytes, silent room.

`playback.mjs` is the worked example.

**Autoplay is the trap this harness fell into, so read this before copying a launch flag.** Granting
`--autoplay-policy=no-user-gesture-required` proves playback in an environment **no television is
ever in**. Measured side by side on a real cooked song:

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
and `sleep` from `../cdp.mjs` and every selector from `../contract.ts` — never hand-write a selector,
because `contract.test.ts` guards those against the source and a hand-written one rots silently.

Exit codes: `0` all passed, `1` a real failure, `2` the environment could not host the test. Never
conflate 2 with 0 — a skipped audio test reporting green is how this hole stayed open.
