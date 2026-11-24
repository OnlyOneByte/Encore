# Deployment examples

Compose **overrides**, not replacements. The override files live in [`docker/`](../../docker/) beside the
base `compose.yaml` — this directory holds the prose runbooks that explain them. Each layers onto
`docker/compose.yaml` rather than copying it, so a change to the base service definition (a new volume,
a new env var, a hardening tweak) reaches every deployment automatically instead of silently applying
to only one of several forked copies.

Use them by stacking `-f` flags — later files win. `./dev.sh compose` supplies the base file, and adds
the GPU override by itself on Linux x86_64 when Docker lists the `nvidia` runtime and `nvidia-smi -L`
sees a GPU. `--cuda` adds it unconditionally, and `ENCORE_TORCH_EXTRA=cpu` keeps it off:

```bash
./dev.sh compose --profile stems up -d                 # the NVIDIA target, picked by itself
./dev.sh compose --cuda --profile stems up -d          # the same, forced

# or by hand, from the repo root, for any override:
docker compose -f docker/compose.yaml -f docker/compose.<target>.yaml \
  --profile stems up -d
```

Storage paths are deliberately **not** set in an override. They stay in `docker/.env`, beside the compose
file (`ENCORE_DATA_VOLUME`, `ENCORE_MEDIA_VOLUME`), because they are a property of the host's disks rather
than of its accelerator. Use **absolute** paths: a relative one resolves against `docker/`, since that is
Compose's project directory.

| file (in `docker/`)        | target                                                        | notes                                                                      |
| -------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `compose.cuda.yaml`  | NVIDIA (e.g. Windows + WSL2 + an NVIDIA GPU)                  | Needs no custom Dockerfile — see below. Full runbook: [`WSL2.md`](WSL2.md) |
| `compose.intel.yaml` | Intel Arc (parked, and BLOCKED)                               | Needs an `xpu` extra in `worker/pyproject.toml`, which does not exist  |

Both overrides now contain **only what is genuinely host-side**: the GPU device reservation, the
`/dev/dri` passthrough, the numeric render/video group ids, and the `TORCH_EXTRA` build arg. They
set **no `ENCORE_*` environment at all**. The worker probes its accelerator, derives its alignment
device from the same decision, and advertises only the capabilities it can prove — so anything these
files declared would be a second, staler copy of facts the box already knows. (Job concurrency is not
probed: it is `ENCORE_WORKER_CONCURRENCY`, default 1, passed through by the base `compose.yaml`.) The drift between an override's capability list and the
base compose file's is exactly what once left songs stuck at 0%.

The one thing still worth stating by hand is `ENCORE_DEVICE=cuda` (or `xpu`) in `docker/.env`, if you want a
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
| The display is driven by the Encore host              | Open **`http://localhost:3000/tv`** on that machine; the QR shows its home-network address, which phones keep using. Nothing to install.                                                                                                                                                                                                 |
| The TV is a separate device with a shell              | Forward the port so the **origin** is localhost: `ssh -N -L 3000:localhost:3000 user@<host>`, then open `http://localhost:3000/tv`. The browser only cares about the origin, not where the bytes come from. No certificates.                                                                                                             |
| The TV is a Chrome you launch yourself                | `--unsafely-treat-insecure-origin-as-secure=http://<LAN-IP>:3000 --user-data-dir=/tmp/encore-tv`. Per-device, and it breaks when the host IP changes. Do not set it in a browser you also use for anything else.                                                                                                                         |
| The TV is an appliance (Chromecast, smart-TV browser) | Real TLS is the only route. `tailscale cert` issues a genuine certificate for `<host>.<tailnet>.ts.net` with no port forwarding, or put Caddy in front. `Bun.serve` takes `tls: { cert, key }` natively and the client already switches to `wss:` on its own, but **`server.ts` is HTTP-only today** — the TLS block does not exist yet. |

A self-signed certificate also works in principle and is usually not worth it: the CA has to be
installed on the television.

**Which address the localhost TV's QR shows.** With no join address saved and no `ENCORE_PUBLIC_ORIGIN`,
it is this box's address on the interface whose default route goes through a router, else its first
192.168.x, else 10.x, always on `PORT` over plain http. A full-tunnel VPN's default route has no router, so it
never outranks the home network. A VPN that routes through its own gateway can still win: choose the address in
Settings -> This machine. It never shows a 172.16-31.x address (Docker's and WSL2's NAT), so
a home network on that range gets the "Phones can't open this address" warning: type the address in
Settings -> This machine, or pick it from the choices there. Behind a tunnel or proxy, set
`ENCORE_PUBLIC_ORIGIN`, which is also a name core answers to, and `ENCORE_TRUST_PROXY=1` if it sets
`X-Forwarded-Host` and `X-Forwarded-Proto` (core ignores them otherwise). Any other name the browser uses goes in
`ENCORE_ALLOWED_HOSTS`, or core answers `421` ([the host allowlist](../SERVER.md#the-host-allowlist)). A tunnel that rewrites `Host` to localhost (`ngrok --host-header=rewrite`) looks
like the localhost TV, so its visitors see the box's private LAN address in the QR; Settings -> This
machine also lists those addresses to anyone who has joined.

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

`docker/worker.Dockerfile` exposes `ARG TORCH_EXTRA`, so switching accelerator selects a different
EXTRA rather than swapping an index URL: `[tool.uv.sources]` in `worker/pyproject.toml` maps each extra
to its own index and declares `cpu` and `cu128` mutually exclusive. Both carry the exact versions the lock
already pins — `torch 2.8.0`, `torchaudio 2.8.0`, `torchvision 0.23.0` — so **no manifest edit is needed**:

- `TORCH_EXTRA=cu128` — cp312 manylinux and win_amd64 wheels both published
- `TORCH_EXTRA=cpu` — the default

There is no `xpu` extra, which is what currently blocks the Intel target (see `docker/compose.intel.yaml`).
The index URLs below are the ones those extras resolve to:

- `https://download.pytorch.org/whl/cu128` — cp312 manylinux and win_amd64 wheels both published
- `https://download.pytorch.org/whl/xpu` — cp312 manylinux wheels published

There is no separate Intel image: `compose.intel.yaml` overrides the ordinary
`docker/worker.Dockerfile`'s build args and adds the `/dev/dri` device and the render/video groups, and PyTorch ships native `torch.xpu` upstream.

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
./dev.sh compose --cuda --profile stems config
```

## "No audio-only format" is not proof the image is broken

`docker/yt-dlp.conf` enables yt-dlp's challenge-solver remote component, and the worker image ships the
deno runtime that executes it. Together those are **necessary but not sufficient**: measured from inside
the built image on a datacenter host, with the whole chain demonstrably live — yt-dlp logged the config,
detected deno, downloaded the solver and ran it with no signature or n-challenge failure — YouTube still
offered only storyboards and the legacy muxed format 18 for a mainstream video, identical to what it
offers with the config removed.

So a second, independent cause produces the same symptom: **the format set is also restricted by who is
asking**, and a datacenter IP can be served a minimal one no matter how well the challenge is solved.
Two consequences, both easy to get backwards:

- A cook that fails to find an audio-only format is **not** evidence that the config or the runtime is
  broken. Verify from the host that will actually run the worker — a residential connection and a
  datacenter one get different answers.
- The format selector's final fallback is what keeps such a host working at all. The new worker asks for
  `-f bestaudio/best` (`audio_argv` in `worker/encore_worker/adapters/cli.py`), and the trailing `best`
  is that fallback: every `bestaudio` branch misses format 18.

## `audio-separator` now installs everywhere, including Apple Silicon

**This section previously said the opposite,** and the change is a version pin rather than new upstream
support. `audio-separator` 0.46.0+ declares
`torch<3,>=2.13; sys_platform == "darwin" and platform_machine == "arm64"`, which no released torch
satisfies — so on an arm64 Mac it was unsatisfiable against any torch, and `pyproject.toml` carried an
environment marker excluding it there. The cost was that the model zoo did not exist on the platform this
project is developed on.

0.45.0 requires only `torch>=2.3` on every platform and carries the IDENTICAL catalogue (verified: the same
89 download entries, the same 84 RoFormer checkpoints), so the pin was moved back and the marker deleted.
`worker/pyproject.toml` now lists `audio-separator==0.45.0` unconditionally, plus `audioread` — an
undeclared dependency of that release, imported by `uvr_lib_v5/spec_utils.py` but absent from its metadata,
so without it `Separator` fails to import on a clean install.

`worker/encore_worker/host/hardware.py` advertises `stems:audiosep` whenever the module is importable,
and `worker/encore_worker/adapters/zoo.py` enumerates what the installed version can actually run —
~135 usable models out of 169, the rest being de-reverb, de-noise, drum-separation and similar, which cannot
produce a karaoke master. Revisit the pin if torch moves past 2.13.

Note that the PyPI distribution is `audio-separator`. `python-audio-separator` is the project name used
in prose; a requirement spelled that way resolves to nothing on every platform, and pip then abandons
the **whole** requirements file rather than that one line.
