# Deployment examples

Compose **overrides**, not replacements. Each file here layers onto the repo-root
`docker-compose.yml` rather than copying it, so a change to the base service definition (a new volume,
a new env var, a hardening tweak) reaches every deployment automatically instead of silently applying
to only one of several forked copies.

Use them by stacking `-f` flags — later files win:

```bash
docker compose -f docker-compose.yml -f docs/deploy/docker-compose.<target>.yml \
  --profile stems up -d
```

Storage paths are deliberately **not** set here. They stay in a `.env` beside the root compose file
(`ENCORE_DATA_VOLUME`, `ENCORE_MEDIA_VOLUME`), because they are a property of the host's disks rather
than of its accelerator.

| file                       | target                                                        | notes                                                                      |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `docker-compose.cuda.yml`  | NVIDIA (the current deploy target: Windows + WSL2 + RTX 3080) | Needs no custom Dockerfile — see below. Full runbook: [`WSL2.md`](WSL2.md) |
| `docker-compose.intel.yml` | Intel Arc (parked — the deploy box changed)                   | Uses the **base** Dockerfile plus the `xpu` wheel index                    |

Both overrides now contain **only what is genuinely host-side**: the GPU device reservation, the
`/dev/dri` passthrough, the numeric render/video group ids, and the `TORCH_INDEX_URL` build arg. They
set **no `ENCORE_*` environment at all**. The worker probes its accelerator, derives its alignment
device from the same decision, sizes its own parallelism against the _usable_ core count, and
advertises only the capabilities it can prove — so anything these files declared would be a second,
staler copy of facts the box already knows. The drift between this directory's capability list and the
base compose file's is exactly what once left songs stuck at 0%.

The one thing still worth stating by hand is `ENCORE_DEVICE=cuda` (or `xpu`) in a `.env`, if you want a
driver or passthrough mistake to fail **loudly** at startup: an explicitly named device that cannot be
reached is a hard error, whereas auto-detection quietly falls back to CPU. That is a deployer's
judgement about how they want to be told, not a property of the hardware, which is why it is not baked
in here.

## The TV needs a SECURE CONTEXT, or it silently loses ±key and the guiding track

**This is the one deployment fact that costs you two features without saying a word.** Serve the TV at
`http://<LAN-IP>:3000/tv` — the address this README tells you to use everywhere else — and the room
gets:

- **no ±key transpose.** The buttons still move, the phone still reports `Key · +2`, the sounding-key
  label and the vocal-range bar still slide. The audio does not change pitch.
- **no guiding track.** The guide slider moves and does nothing.

Neither failure prints anything, in any log, on any surface.

**Why.** Both features run through one `AudioWorklet` (`src/lib/tv/pitch-shift.ts` — the SOLA pitch
shifter, and the 4-channel splitter that pulls the guiding track out of the guide mix). `AudioWorklet`
is a **secure-context-only API**: browsers expose it on `https://` and on the `localhost` family, and
nowhere else. `http://192.168.1.20:3000` is not a secure context, so `ctx.audioWorklet` is `undefined`,
the graph build throws, and the player degrades to the element's native output — audible, unshifted,
and with the guide's channels never separated. The degrade is deliberately quiet, because its whole job
is to keep the room's audio alive when the graph cannot be built; it was never meant to be the normal
case.

**How to confirm it in ten seconds.** On the TV, in devtools:

```js
console.log('secure:', isSecureContext, 'worklet:', !!new AudioContext().audioWorklet);
```

`secure: false, worklet: false` is this problem. Nothing else produces that pair.

**Which surfaces care:** only the TV. Phones are remotes — they run no audio DSP — so they are correct
on the LAN IP and need none of what follows.

### Getting a secure context, cheapest first

| Situation                                             | What to do                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The display is driven by the Encore host              | Open **`http://localhost:3000/tv`** on that machine. Phones keep using the LAN IP. Nothing to install.                                                                                                                                                                                                                                   |
| The TV is a separate device with a shell              | Forward the port so the **origin** is localhost: `ssh -N -L 3000:localhost:3000 user@<host>`, then open `http://localhost:3000/tv`. The browser only cares about the origin, not where the bytes come from. No certificates.                                                                                                             |
| The TV is a Chrome you launch yourself                | `--unsafely-treat-insecure-origin-as-secure=http://<LAN-IP>:3000 --user-data-dir=/tmp/encore-tv`. Per-device, and it breaks when the host IP changes. Do not set it in a browser you also use for anything else.                                                                                                                         |
| The TV is an appliance (Chromecast, smart-TV browser) | Real TLS is the only route. `tailscale cert` issues a genuine certificate for `<host>.<tailnet>.ts.net` with no port forwarding, or put Caddy in front. `Bun.serve` takes `tls: { cert, key }` natively and the client already switches to `wss:` on its own, but **`server.ts` is HTTP-only today** — the TLS block does not exist yet. |

A self-signed certificate also works in principle and is usually not worth it: the CA has to be
installed on the television.

### Why this is not simply fixed in code

There is no non-secure path to `AudioWorklet`, so nothing in this repo can lift the restriction. The
options are all trades, and none is free:

- **`ScriptProcessorNode`** is not secure-context gated and would restore instant transposition on
  plain HTTP — but it processes on the **main thread**, competing with the lyrics reel and the
  visualizer, and its buffer adds ~90 ms of audio delay against the words. It is also deprecated.
- **Server-side transposition** (ffmpeg `asetrate`/`aresample`/`atempo`, cached under
  `derived/pitch/`) works on every client with no browser requirement at all, but a key change becomes
  a stream swap and a seek — no longer instant.

The guiding track, unlike ±key, does **not** need the worklet — a `ChannelSplitter` and a `GainNode` are
ordinary Web Audio and run happily on an insecure origin. It used to fail anyway, because the splitter
hung off the worklet node and one missing secure-context API took the whole graph down with it. **That is
now decoupled:** a missing or refusing worklet leaves the split graph intact, so the guide slider works on
a plain `http://<LAN-IP>` origin. Only ±key still needs a secure context, and `PitchShiftGraph.isShiftable`
reports when it is unavailable so the transpose control can say so instead of moving silently.

`worker/Dockerfile` already exposes `ARG TORCH_INDEX_URL`, so switching accelerator is a wheel
index swap. Both of these carry the exact versions `worker/requirements.txt` already pins —
`torch 2.8.0`, `torchaudio 2.8.0`, `torchvision 0.23.0` — so **no requirements edit is needed** for
either:

- `https://download.pytorch.org/whl/cu128` — cp312 manylinux and win_amd64 wheels both published
- `https://download.pytorch.org/whl/xpu` — cp312 manylinux wheels published

There used to be a `Dockerfile.intel` here, because Intel Arc support originally required
`intel-extension-for-pytorch` as an extra pip install whose version had to be matched to _both_ the
host driver and the pinned torch. **It has been deleted.** PyTorch ships native `torch.xpu` upstream and
the `xpu` index carries the whole pinned set, so `docker-compose.intel.yml` uses the ordinary
Dockerfile; `backends.py` still imports IPEX before torch when it happens to be installed, which makes
that path belt-and-braces rather than something needing its own image. Recover it from git history if a
specific driver pairing ever turns out to need IPEX after all.

Note the limit of the one-image goal, since it decides this directory's shape: a pip environment holds
exactly **one** torch build (all three indexes publish the same version string with different build
content), and the `cu128` and `xpu` wheels are **x86_64-only** — there is no aarch64 CUDA wheel at 2.8.
So architecture determines the wheel on arm64, and CUDA-vs-Intel on amd64 remains a genuine choice that
no manifest can make for you. Apple MPS needs no special index at all: the plain `cpu` index's macOS
arm64 wheel is the MPS-capable one, and Metal cannot be passed into a Linux container anyway, so a Mac
worker is a native run rather than an image.

## Verifying a merge before you run it

`config` resolves the stack and prints the effective result without starting anything — the cheapest
way to confirm an override landed where you meant:

```bash
docker compose -f docker-compose.yml -f docs/deploy/docker-compose.cuda.yml --profile stems config
```
