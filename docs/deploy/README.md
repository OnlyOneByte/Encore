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
| `Dockerfile.intel` | Intel Arc, IPEX fallback only | Parked. Superseded by the line below; kept in case a driver pairing needs IPEX after all |

## Why CUDA needs no Dockerfile but Intel once did

`apps/worker/Dockerfile` already exposes `ARG TORCH_INDEX_URL`, so switching accelerator is a wheel
index swap. Both of these carry the exact versions `apps/worker/requirements.txt` already pins —
`torch 2.8.0`, `torchaudio 2.8.0`, `torchvision 0.23.0` — so **no requirements edit is needed** for
either:

- `https://download.pytorch.org/whl/cu128` — cp312 manylinux and win_amd64 wheels both published
- `https://download.pytorch.org/whl/xpu` — cp312 manylinux wheels published

`Dockerfile.intel` exists because Intel Arc support originally required
`intel-extension-for-pytorch` as an extra pip install whose version had to be matched to *both* the
host driver and the pinned torch. That is no longer true: PyTorch ships native `torch.xpu` upstream and
the `xpu` index carries the whole pinned set, so `docker-compose.intel.yml` uses the ordinary
Dockerfile. The IPEX variant is kept only as a fallback if a specific driver pairing turns out to need
it.

## Verifying a merge before you run it

`config` resolves the stack and prints the effective result without starting anything — the cheapest
way to confirm an override landed where you meant:

```bash
docker compose -f docker-compose.yml -f docs/deploy/docker-compose.cuda.yml --profile stems config
```
