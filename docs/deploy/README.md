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

| file | target | notes |
|---|---|---|
| `docker-compose.cuda.yml` | NVIDIA (the current deploy target: Windows + WSL2 + RTX 3080) | Needs no custom Dockerfile — see below. Full runbook: [`../DEPLOY-WSL2.md`](../DEPLOY-WSL2.md) |
| `docker-compose.intel.yml` | Intel Arc (parked — the deploy box changed) | Uses the **base** Dockerfile plus the `xpu` wheel index |

Both overrides now contain **only what is genuinely host-side**: the GPU device reservation, the
`/dev/dri` passthrough, the numeric render/video group ids, and the `TORCH_INDEX_URL` build arg. They
set **no `ENCORE_*` environment at all**. The worker probes its accelerator, derives its alignment
device from the same decision, sizes its own parallelism against the *usable* core count, and
advertises only the capabilities it can prove — so anything these files declared would be a second,
staler copy of facts the box already knows. The drift between this directory's capability list and the
base compose file's is exactly what once left songs stuck at 0%.

The one thing still worth stating by hand is `ENCORE_DEVICE=cuda` (or `xpu`) in a `.env`, if you want a
driver or passthrough mistake to fail **loudly** at startup: an explicitly named device that cannot be
reached is a hard error, whereas auto-detection quietly falls back to CPU. That is a deployer's
judgement about how they want to be told, not a property of the hardware, which is why it is not baked
in here.

## Why CUDA needs no Dockerfile but Intel once did

`apps/worker/Dockerfile` already exposes `ARG TORCH_INDEX_URL`, so switching accelerator is a wheel
index swap. Both of these carry the exact versions `apps/worker/requirements.txt` already pins —
`torch 2.8.0`, `torchaudio 2.8.0`, `torchvision 0.23.0` — so **no requirements edit is needed** for
either:

- `https://download.pytorch.org/whl/cu128` — cp312 manylinux and win_amd64 wheels both published
- `https://download.pytorch.org/whl/xpu` — cp312 manylinux wheels published

There used to be a `Dockerfile.intel` here, because Intel Arc support originally required
`intel-extension-for-pytorch` as an extra pip install whose version had to be matched to *both* the
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
