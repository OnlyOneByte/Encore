# Deploying Encore on Windows + WSL2 with an NVIDIA GPU

Target: a Windows x86_64 box with an RTX 3080 (10 GB), serving a party over the LAN.

The approach is **not** "port Encore to Windows". It is to run the existing Linux containers inside
WSL2 with GPU passthrough, so the deployment is a Linux deployment again and the images are unchanged.
Core is Bun + SvelteKit and the worker is Python + torch; both already build for `linux/amd64`, and the
worker's Dockerfile already takes a `TORCH_INDEX_URL` build-arg precisely so a GPU host can swap the
torch wheels.

> **Nothing in this runbook has been executed.** It was written from the repo's compose file,
> Dockerfiles and route code on an aarch64 Linux box with no NVIDIA hardware. Treat every command as
> reviewed-but-unverified, and check the verification gates in §6 rather than assuming.

---

## 1. The one thing that will break first: networking

Encore's whole join flow is *phones on the LAN scan a QR shown on the TV*. Two facts collide:

- **Default WSL2 networking is NAT.** Windows can reach a WSL service on `localhost`, but **other
  devices on your LAN cannot reach it at all.** Phones will simply fail to connect.
- **The QR follows the `Host` header of the request that loaded the TV.**
  `apps/core/src/routes/tv/+page.server.ts` builds `joinUrl` via `publicOrigin(request, url)`
  (`apps/core/src/server/public-origin.ts`), which takes the authority from `X-Forwarded-Host` or
  `Host`, and the scheme from `X-Forwarded-Proto` defaulting to `http`. So the QR contains whatever
  address the *TV browser* used to load `/tv`. Open the TV at `http://localhost:3000/tv` and the QR
  says `localhost` — useless to a phone, even if the network were otherwise fine.

  > Worth knowing why that helper exists: `adapter-node` reports the protocol as
  > `protocol_header && headers.get(protocol_header) || "https"`, so with no `PROTOCOL_HEADER`
  > configured it called **every** request https — and `url.origin` produced an `https://` QR on
  > exactly the plain-HTTP LAN deployment this runbook describes. It stayed hidden because the usual
  > test path is an https tunnel. Core itself only ever speaks plain HTTP; TLS is always terminated
  > upstream. A WSL2 LAN deployment is the plain-HTTP case, so this fix is load-bearing here.

**Fix both.** Use WSL mirrored networking, which makes WSL share the Windows host's network
interfaces so LAN devices reach it directly. Create or edit `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
# torch + WhisperX are memory-hungry; set this deliberately rather than taking the default.
memory=16GB
processors=8

[experimental]
hostAddressLoopback=true
```

Then `wsl --shutdown` and restart. Mirrored mode needs **Windows 11 22H2 or newer with WSL 2.0+**
(`wsl --version` to check).

**If mirrored mode is unavailable** (Windows 10, or an older WSL), fall back to a port proxy from an
Administrator PowerShell — replacing the WSL IP each boot, because NAT reassigns it:

```powershell
$wslIp = (wsl hostname -I).Trim().Split()[0]
netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0 2>$null
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$wslIp
```

Either way, allow inbound 3000 through Windows Firewall:

```powershell
New-NetFirewallRule -DisplayName "Encore 3000" -Direction Inbound -LocalPort 3000 `
  -Protocol TCP -Action Allow -Profile Private
```

Keep the rule on the **Private** profile only. This is an unauthenticated service — see §7.

---

## 2. Prerequisites

| Component | Requirement | Check |
|---|---|---|
| Windows | 11 22H2+ (for mirrored networking) | `winver` |
| WSL | 2.0+, with a distro (Ubuntu 24.04) | `wsl --version`, `wsl -l -v` |
| NVIDIA driver | A current **Windows** driver. Do **not** install a driver inside WSL — CUDA-on-WSL comes from the Windows driver | `nvidia-smi` in PowerShell |
| Docker | Docker Desktop with the WSL2 backend, **or** docker-ce inside the distro plus `nvidia-container-toolkit` | `docker version` |

Docker Desktop is the shorter path (its WSL2 backend wires up GPU access for you). Installing
`docker-ce` directly in the distro avoids Docker Desktop entirely but means installing
`nvidia-container-toolkit` yourself:

```bash
curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey \
  | sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg
curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list \
  | sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' \
  | sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list
sudo apt-get update && sudo apt-get install -y nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker && sudo service docker restart
```

**Gate before going further** — if either of these fails, stop and fix the driver/toolchain; nothing
below will work:

```bash
nvidia-smi                                     # inside WSL
docker run --rm --gpus all nvidia/cuda:12.8.0-base-ubuntu24.04 nvidia-smi
```

---

## 3. Clone inside the WSL filesystem, never on /mnt/c

```bash
sudo mkdir -p /srv && sudo chown "$USER" /srv
cd /srv && git clone <your-remote> Encore && cd Encore
```

**Do not put the repo, `data/`, or `media/` under `/mnt/c/...`.** Windows drives are exposed to WSL
over a 9p filesystem, which is dramatically slower and does not honour POSIX locking properly. Encore
writes multi-hundred-MB audio files *and* runs SQLite in WAL mode; on `/mnt/c` you get both terrible
throughput and a real risk of database locking errors. Everything stateful stays on the distro's ext4.

To reach the media from Windows Explorer, browse `\\wsl$\Ubuntu\srv\Encore\media` — read from Windows,
but let the containers own the writes.

---

## 4. Required repo changes

Three edits are needed; the compose file even carries a placeholder comment for the GPU one
(`# deploy.resources.reservations.devices for GPU added when stems land`). Apply these to
`docker-compose.yml`:

```diff
--- docker-compose.yml
+++ docker-compose.yml
@@ worker:
     build:
       context: .
       dockerfile: apps/worker/Dockerfile
+      args:
+        # CPU wheels stay the default so the dev box is unaffected; a GPU host flips this in .env.
+        TORCH_INDEX_URL: ${ENCORE_TORCH_INDEX_URL:-https://download.pytorch.org/whl/cpu}
     profiles: ["stems"]
@@
     restart: unless-stopped
-    # deploy.resources.reservations.devices for GPU added when stems land
+    deploy:
+      resources:
+        reservations:
+          devices:
+            - driver: nvidia
+              count: 1
+              capabilities: [gpu]
```

`deploy.resources.reservations.devices` is honoured by `docker compose up` (unlike most other `deploy`
keys, which are Swarm-only). The newer `gpus: all` shorthand also works on current Compose.

Then a `.env` beside `docker-compose.yml`:

```dotenv
# ── GPU worker ────────────────────────────────────────────────────────────────
# cu128 carries the exact versions requirements.txt already pins: torch 2.8.0,
# torchaudio 2.8.0, torchvision 0.23.0. No requirements.txt edit is needed.
ENCORE_TORCH_INDEX_URL=https://download.pytorch.org/whl/cu128

# EXPLICIT, not auto. backends.py refuses a device it cannot reach, so naming cuda here turns a
# driver or passthrough mistake into a loud startup failure instead of a silent 20x-slower CPU cook.
ENCORE_DEMUCS_DEVICE=cuda
ENCORE_WHISPERX_DEVICE=cuda

# Word-timed lyrics and live scoring as well as stems. `fetch:ytdlp` lets this worker acquire audio —
# without a fetch-capable worker every new song sits at 0% forever.
ENCORE_WORKER_CAPABILITIES=stems,align,score,fetch:ytdlp

# One song at a time to start. On a GPU this contends for VRAM, not CPU cores — see §5.
ENCORE_WORKER_CONCURRENCY=1

# ── storage: ext4 inside the distro, never /mnt/c ─────────────────────────────
ENCORE_DATA_VOLUME=/srv/encore/data
ENCORE_MEDIA_VOLUME=/srv/encore/media
```

```bash
mkdir -p /srv/encore/data /srv/encore/media
```

**Leave the `worker-cache` named volume alone.** It holds the demucs and RoFormer checkpoints
(hundreds of MB) and yt-dlp's challenge-solver script. It is a *named* volume rather than a bind path
on purpose: Docker initialises it from the image's own `$XDG_CACHE_HOME`, so it inherits the
worker's ownership, whereas a fresh bind directory would be created root-owned and the unprivileged
worker (uid 10001) could not write to it. Converting it to a bind mount breaks the worker.

---

## 5. Bring it up

```bash
cd /srv/Encore
docker compose --profile stems build          # the CUDA torch wheels are multi-GB; expect a long first build
docker compose --profile stems up -d
docker compose logs -f worker
```

**Two knobs change meaning on a GPU** and are worth understanding before you tune anything:

- `ENCORE_DEMUCS_JOBS` and `ENCORE_TORCH_THREADS` are derived from CPU core count
  (`auto_demucs_jobs`, `auto_torch_threads`). On the GPU path they are largely irrelevant, and the
  worker may still print a CPU-derived value — treat that line as informational, not as a claim about
  what the GPU is doing.
- `ENCORE_WORKER_CONCURRENCY` now contends for **VRAM**, not cores. 10 GB is comfortable for one
  separation, but not for a separation *and* WhisperX large-v3 at the same time. Raise concurrency
  only after watching `nvidia-smi` through a real cook, and expect CUDA OOM rather than graceful
  slowdown if you overcommit.

---

## 6. Verification gates

Work down this list; each one isolates a different failure.

```bash
# 1. torch actually sees the GPU inside the worker container
docker compose exec worker python -c \
  "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# expect: 2.8.0+cu128 True NVIDIA GeForce RTX 3080
```

2. **Worker startup line.** `dial_home.py` resolves the backend and prints it. Grep the logs for:

   ```
   [worker] separator backend: torch — explicitly configured torch (explicitly configured device cuda)
   ```

   The device must be named. If it instead reports auto-selection with no accelerator, then
   `ENCORE_DEMUCS_DEVICE=cuda` never reached the container — and per `backends.py`'s contract an
   explicitly-requested-but-unavailable device *raises*, so a quiet CPU line means the env var is
   missing rather than the GPU being unreachable. The config line from `Config.describe()` also
   carries `device=`; `device=auto` there is the same tell.

3. **Core is reachable from Windows:** open `http://localhost:3000/tv` in a Windows browser.

4. **Core is reachable from the LAN** — the step that catches the NAT problem. From your phone,
   browse to `http://<windows-lan-ip>:3000/tv`. Get the address with `ipconfig` in PowerShell (the
   Wi-Fi/Ethernet adapter, **not** a `vEthernet (WSL)` address).

5. **Open the TV at the LAN address, not localhost.** The QR takes its authority from the request's
   `Host` header, so the TV must be loaded as `http://<windows-lan-ip>:3000/tv` for the QR to encode
   something a phone can use. This is the single easiest mistake to make. Neither mirrored networking
   nor the portproxy fallback rewrites `Host`, so in both modes the QR simply mirrors what you typed.

6. **End to end:** scan the QR, join with a name and colour, search a song, tap Karaoke, and watch
   `nvidia-smi` during the cook. If VRAM usage and GPU utilisation stay flat, the cook is running on
   CPU regardless of what anything claims.

7. **Re-measure.** Run the committed benchmark scripts on this box and add a CUDA column to
   `docs/benchmarks/SUMMARY.md`:
   `docs/benchmarks/scripts/checkpoint_cost.py` and `docs/benchmarks/scripts/family_bench.sh`. Every
   realtime factor recorded so far is from a 32-core Graviton 3 CPU box, and the ranking may reorder
   entirely — the mel-band checkpoints won on CPU partly for architectural reasons that matter less
   once tensor cores dominate. `SUMMARY.md` currently asserts that no engine becomes live-tier by
   moving hardware; that was measured against an Intel Arc and is expected to be **false** here.

---

## 7. Security: this service has no authentication

Encore has no accounts and no host role. Anyone who can reach port 3000 can join a room, queue songs,
control playback, and change global settings. That is fine on a home LAN and is the product's design —
but it means:

- Keep the firewall rule on the **Private** profile. Do not port-forward 3000 from your router.
- Do not put this on a network you do not control.
- If you ever need remote access, put it behind a tunnel or reverse proxy that does the
  authentication; do not expose it directly. If you do, make the proxy set `X-Forwarded-Host` and
  `X-Forwarded-Proto` — `publicOrigin()` believes both, and they are what make the join QR encode the
  public hostname and `https` instead of the container's own plain-HTTP address.

---

## 8. Autostart

`restart: unless-stopped` is already set on both services, so containers come back on their own —
but only once Docker is running, and under WSL that needs a nudge at logon.

Simplest: enable "Start Docker Desktop when you log in", plus a Task Scheduler task at logon running

```
wsl -d Ubuntu --cd /srv/Encore -- docker compose --profile stems up -d
```

Then stop Windows from sleeping mid-song:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

---

## 9. Rollback

The GPU path is opt-in through two env vars, so reverting is a config change plus a rebuild:

```bash
# in .env: drop ENCORE_TORCH_INDEX_URL and ENCORE_DEMUCS_DEVICE (or set the device to cpu)
docker compose --profile stems build worker && docker compose --profile stems up -d worker
```

Data and media are untouched by this — they live in the volumes from §4, not in the image.

---

## Known unknowns

Flagged rather than glossed, because each could cost an evening:

- **`cap_drop: ALL` plus GPU passthrough.** Every service runs with all Linux capabilities dropped
  and `no-new-privileges`. CUDA needs device nodes rather than capabilities, so this *should* be
  fine, but it is unverified on this stack. If the GPU is invisible inside the container while
  `docker run --gpus all` works standalone, temporarily relax the hardening on the worker to confirm
  that is the cause before changing anything else.
- **Mirrored networking with Docker Desktop.** Both features rewrite WSL networking; their
  interaction is not something this runbook has tested. If phones cannot reach port 3000 under
  mirrored mode, the §1 portproxy fallback is the escape hatch.
- **First-cook downloads.** The first `stems` cook fetches the separator checkpoint and yt-dlp's
  solver script into `worker-cache`. Expect a slow first song, not a hang.
