# Deploying Encore on Windows + WSL2 with an NVIDIA GPU

Target: a Windows x86_64 box with an NVIDIA GPU, serving a party over the LAN.

The approach is **not** "port Encore to Windows". It is to run the existing Linux containers inside
WSL2 with GPU passthrough, so the deployment is a Linux deployment again and the images are unchanged.
Core is Bun + SvelteKit and the worker is Python + torch; both already build for `linux/amd64`, and
`docker/worker.Dockerfile` takes a `TORCH_EXTRA` build-arg (`cpu` or `cu128`; `docker/compose.cuda.yaml`
sets `cu128`) so a GPU host gets the CUDA torch wheels.

> **Nothing in this runbook has been executed.** It was written from the repo's compose file,
> Dockerfiles and route code on an aarch64 Linux box with no NVIDIA hardware. Treat every command as
> reviewed-but-unverified, and check the verification gates in §6 rather than assuming.

---

## 1. The one thing that will break first: networking

Encore's whole join flow is _phones on the LAN scan a QR shown on the TV_. Two facts collide:

- **Default WSL2 networking is NAT.** Windows can reach a WSL service on `localhost`, but **other
  devices on your LAN cannot reach it at all.** Phones will simply fail to connect.
- **Unless an address is declared, the QR follows the `Host` header of the request that loaded the TV.**
  `core/src/routes/tv/+page.server.ts` builds `joinUrl` via `joinOrigin(request, url)`
  (`core/src/lib/server/public-origin.ts`): the `joinOrigin` setting if one is saved, else
  `ENCORE_PUBLIC_ORIGIN`, else the request — the authority from `X-Forwarded-Host` or `Host`, and the
  scheme from `X-Forwarded-Proto` defaulting to `http`. With neither declared, the QR contains whatever
  address the _TV browser_ used to load `/tv`. A TV opened at `localhost` gets the box's own 192.168.x or
  10.x address instead, but inside WSL2 the only one is the NAT's 172.x, which is never advertised, so
  the QR says `localhost` — useless to a phone, even if the network were otherwise fine.

  > Worth knowing why that helper exists: `adapter-node` reports the protocol as
  > `protocol_header && headers.get(protocol_header) || "https"`, so with no `PROTOCOL_HEADER`
  > configured it called **every** request https — and `url.origin` produced an `https://` QR on
  > exactly the plain-HTTP LAN deployment this runbook describes. It stayed hidden because the usual
  > test path is an https tunnel. Core itself only ever speaks plain HTTP; TLS is always terminated
  > upstream. A WSL2 LAN deployment is the plain-HTTP case, so this fix is load-bearing here.

**Fix both.** Use WSL mirrored networking, which makes WSL share the Windows host's network
interfaces so LAN devices reach it directly.

**Update WSL first.** Mirrored networking needs **WSL 2.0.0 or newer**, and the version shipped in the
box is usually older than that — so do this before writing any config, because a stale WSL silently
ignores the setting rather than reporting it:

```powershell
wsl --version              # want: WSL version 2.0.0 or newer
wsl --update               # in-place update of the WSL runtime + kernel
wsl --update --pre-release # only if --version is still too old after the above
wsl --shutdown             # required for a new.wslconfig to be read
```

`wsl --update` updates the WSL _runtime_, not your distro's packages. Those are separate:

```bash
# inside the distro, for the packages Encore actually uses
sudo apt update && sudo apt upgrade -y
```

Now create or edit `C:\Users\<you>\.wslconfig`:

```ini
[wsl2]
networkingMode=mirrored
# Lets the distro reach services bound on the Windows host (and vice versa). A [wsl2] key, NOT an
# experimental one — see the warning below.
hostAddressLoopback=true
# torch + WhisperX are memory-hungry; set this deliberately rather than taking the default.
memory=16GB
processors=8
```

Then `wsl --shutdown` and restart.

> **Do NOT put these under `[experimental]`.** Older guides — and earlier revisions of this file — show
> `hostAddressLoopback` (and sometimes `networkingMode`) inside an `[experimental]` section, because that
> is where they lived while mirrored networking was in preview. They are ordinary `[wsl2]` keys as of
> WSL 2.0, and leaving them under `[experimental]` on a current WSL means they are **parsed and
> ignored**: you get no error, no warning, and a box that behaves exactly as if you had never edited the
> file. That is a genuinely expensive failure to debug, because every symptom points at the firewall or
> the app instead of at the config. If you have an `[experimental]` block from an older guide, delete it
> outright rather than moving keys out of it one at a time.

### Mirrored mode needs the Hyper-V firewall opened too — this is the step that bites

The Windows Firewall rule below is **not sufficient on its own** in mirrored mode. Inbound LAN traffic
to a WSL-bound service is governed by the separate **Hyper-V firewall**, which defaults to blocking it.
Symptom: everything looks correct — the service is listening, the address is right — and phones still
cannot connect. It is a known rough edge ([microsoft/WSL#10535](https://github.com/microsoft/WSL/issues/10535)).

From an **Administrator** PowerShell, open just the one port:

```powershell
New-NetFirewallHyperVRule -Name "Encore3000" -DisplayName "Encore 3000" `
  -Direction Inbound -VMCreatorId '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' `
  -Protocol TCP -LocalPorts 3000
```

That GUID is WSL's own VM creator ID. The blunter alternative, if you would rather not manage it
per-port, allows all inbound to WSL:

```powershell
Set-NetFirewallHyperVVMSetting -Name '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}' -DefaultInboundAction Allow
```

### Finding the address in mirrored mode

Mirrored mode also makes the address harder to read, not easier: WSL now shows the host's interfaces
_plus_ a synthetic `loopback0`, so `hostname -I` returns a list and it is not obvious which entry a
phone should use. Ask the routing table which source address actually reaches the outside world:

```bash
ip route get 1.1.1.1 | grep -oP 'src \K\S+'
```

and cross-check from Windows, which is authoritative:

```powershell
(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway }).IPv4Address.IPAddress
```

**Those two agreeing IS the check that mirrored mode took effect.** If WSL reports a `172.x` while
Windows reports your `192.168.x`, you are still on NAT: `.wslconfig` was not picked up (wrong path — it
must be `%USERPROFILE%\.wslconfig` — an `[experimental]` block swallowing the keys, or no
`wsl --shutdown` afterwards), and the portproxy fallback below applies instead.

> `networkingMode=bridged` is a **different** mode, not a synonym. It needs `vmSwitch=` naming an
> _external_ Hyper-V vSwitch and takes its own DHCP lease; without that switch it has no usable
> address at all. Use `mirrored`.

### Mirrored mode can activate and still be broken — observed on this deployment

Worth knowing before you spend an evening on it: on the actual deploy box, mirrored mode came up
**half-working**. `loopback0` was present, which is the tell that mirrored mode _did_ activate, but the
`eth` interface was **DOWN**, so nothing was reachable from the LAN at all. That combination is
confusing precisely because the usual check (does mirrored appear active?) says yes.

Diagnose it with:

```bash
ip -br link          # loopback0 present = mirrored active; look for eth* state DOWN
ip -br addr          # a mirrored eth with no address is the broken case
```

**The fix that actually worked was to go back to NAT + portproxy** — delete `networkingMode=mirrored`
from `.wslconfig`, `wsl --shutdown`, and use the port proxy below. Do not read that as "mirrored is
wrong"; it is the cleaner mode when it works, and it removes the per-boot IP dance. But if you are
debugging a phone that cannot connect, the portproxy path is the one this deployment has actually
verified end to end, so switch to it early rather than treating it as a last resort.

**Use the port proxy** when mirrored is unavailable (Windows 10, or an older WSL) _or_ when it comes up
broken as above. From an Administrator PowerShell — replacing the WSL IP each boot, because NAT
reassigns it:

```powershell
$wslIp = (wsl hostname -I).Trim().Split()[0]
netsh interface portproxy delete v4tov4 listenport=3000 listenaddress=0.0.0.0 2>$null
netsh interface portproxy add v4tov4 listenport=3000 listenaddress=0.0.0.0 connectport=3000 connectaddress=$wslIp
netsh interface portproxy show v4tov4     # confirm the rule is there and points at the current IP
```

Either way, allow inbound 3000 through Windows Firewall:

```powershell
New-NetFirewallRule -DisplayName "Encore 3000" -Direction Inbound -LocalPort 3000 `
  -Protocol TCP -Action Allow -Profile Private
```

Keep the rule on the **Private** profile only. This is an unauthenticated service — see §7.

---

## 2. Prerequisites

| Component     | Requirement                                                                                                      | Check                        |
| ------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Windows       | 11 22H2+ (for mirrored networking)                                                                               | `winver`                     |
| WSL           | 2.0+, with a distro (Ubuntu 24.04)                                                                               | `wsl --version`, `wsl -l -v` |
| NVIDIA driver | A current **Windows** driver. Do **not** install a driver inside WSL — CUDA-on-WSL comes from the Windows driver | `nvidia-smi` in PowerShell   |
| Docker        | Docker Desktop with the WSL2 backend, **or** docker-ce inside the distro plus `nvidia-container-toolkit`         | `docker version`             |

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
writes multi-hundred-MB audio files _and_ runs SQLite in WAL mode; on `/mnt/c` you get both terrible
throughput and a real risk of database locking errors. Everything stateful stays on the distro's ext4.

To reach the media from Windows Explorer, browse `\\wsl$\Ubuntu\srv\Encore\media` — read from Windows,
but let the containers own the writes.

---

## 4. Configure

No edits to `docker/compose.yaml` are needed. The GPU deployment is a compose **override**:
[`docker/compose.cuda.yaml`](../../docker/compose.cuda.yaml). It supplies the CUDA wheel
index as a build arg, the NVIDIA device reservation, and the device env — layered onto the base file
rather than forking it, so later changes to core, the hardening anchor or the volume wiring still
reach this deployment. See [`docs/deploy/README.md`](README.md) for the pattern.

Every command below uses one prefix; export it once per shell:

```bash
cd /srv/Encore
export EC="./dev.sh compose --cuda"
```

The only thing you must set yourself is **where state lives**, because that is a property of the host's
disks rather than its GPU. `docker/.env`, beside the compose file:

```dotenv
# ext4 inside the distro. NEVER /mnt/c — see §3.
ENCORE_DATA_VOLUME=/srv/encore/data
ENCORE_MEDIA_VOLUME=/srv/encore/media

# The address the join QR advertises. Set this on WSL2 even though it looks redundant: the port proxy
# forwards traffic arriving FROM the network, not the host's own loopback path, so this machine
# typically cannot open http://<its-own-LAN-IP>:3000 — only localhost:3000. Without the override, a TV
# opened on localhost puts `localhost` in the QR and every phone that scans it connects to itself.
ENCORE_PUBLIC_ORIGIN=http://192.168.1.20:3000
```

```bash
mkdir -p /srv/encore/data /srv/encore/media
```

**Leave the `worker-cache` named volume alone.** It holds the demucs and RoFormer checkpoints
(hundreds of MB) and yt-dlp's challenge-solver script. It is a _named_ volume rather than a bind path
on purpose: Docker initialises it from the image's own `$XDG_CACHE_HOME`, so it inherits the
worker's ownership, whereas a fresh bind directory would be created root-owned and the unprivileged
worker (uid 10001) could not write to it. Converting it to a bind mount breaks the worker.

Confirm the merge resolved the way you expect before building anything:

```bash
$EC --profile stems config | less    # look for TORCH_EXTRA: cu128 and driver: nvidia
```

The overrides intentionally set no `ENCORE_*` device or capability variables any more — the worker
probes its own accelerator and reports it. `ENCORE_DEVICE` appears here only if you put it in `docker/.env`
yourself, which is worth doing on this box for the reason in the verification step below.

---

## 5. Bring it up

```bash
$EC --profile stems build          # the CUDA torch wheels are multi-GB; expect a long first build
$EC --profile stems up -d
$EC logs -f worker
```

**One knob changes meaning on a GPU:** `ENCORE_WORKER_CONCURRENCY` (default 1, read in
`worker/encore_worker/host/config.py`) contends for **VRAM**, not cores. Raise it only after watching
`nvidia-smi` through a real process, and expect CUDA OOM rather than graceful slowdown if you overcommit.

---

## 6. Verification gates

Work down this list; each one isolates a different failure.

```bash
# 1. torch actually sees the GPU inside the worker container
$EC exec worker python -c \
  "import torch; print(torch.__version__, torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# expect: 2.8.0+cu128 True <your GPU's name>
```

2. **Worker startup line.** `worker/encore_worker/__main__.py` probes the hardware, resolves the backend and
   the device, and prints one line before it connects. Grep the logs for it:

   ```
   [worker] <worker id> on <platform> (<machine>); accelerator=cuda device=cuda backend=torch (<why>); capabilities=<list>
   ```

   `accelerator=` is what the probe found; `device=` is what the models are built on — `ENCORE_DEVICE` if you
   set it, else the detected accelerator (`device_for` in the same file). If it reports `accelerator=cpu`, the
   GPU is not reachable inside the container — driver, `nvidia-container-toolkit`, or the device reservation.
   Detection falls back to CPU **quietly**, which on this workload is the difference between minutes and most
   of an hour, so on a box you _expect_ to have a GPU it is worth putting `ENCORE_DEVICE=cuda` in
   `docker/.env`: the configured device wins over detection, so a missing GPU surfaces as a torch error
   instead of a silent CPU run.

3. **Core is reachable from Windows:** open `http://localhost:3000/tv` in a Windows browser.

4. **Core is bound to all interfaces, not just loopback.** Inside WSL:

   ```bash
   ss -tlnp | grep 3000     # want 0.0.0.0:3000 or *:3000
   ```

   A `127.0.0.1:3000` bind is reachable from Windows and _never_ from the LAN — the same symptom as a
   firewall block, from a completely different cause. Encore defaults `HOST=0.0.0.0`, so this should
   already pass; check it before blaming the network.

5. **Core is reachable from the LAN** — the step that catches both the NAT problem and the Hyper-V
   firewall. From your phone, browse to `http://<windows-lan-ip>:3000/tv`. Get the address with the
   two cross-checked commands in §1, not by eyeballing `ipconfig` — in mirrored mode there are several
   plausible-looking addresses and only one of them works.

6. **The QR must encode the LAN address, not `localhost`.** Two ways to get there, and on WSL2 you
   almost certainly need the second:

   - Load the TV as `http://<windows-lan-ip>:3000/tv`, so the request's `Host` header carries the right
     authority. Works only when the server box can reach its own LAN address.
   - **Set `ENCORE_PUBLIC_ORIGIN`** (§4). Then the QR is correct no matter which URL the TV was opened
     with, `localhost` included. This is the normal WSL2 + portproxy case: the proxy forwards traffic
     arriving _from the network_, not the host's own loopback path, so the server machine typically
     cannot open its own LAN address at all — and it is usually the machine attached to the TV.
   - Or set **Global → Joining → "Address phones join at"** on the phone settings page. Same value, same
     precedence rules (the setting wins over the env var), no restart — which is the one that helps when
     you are standing in the room and the QR says `localhost`. The TV picks up the change live.

   **Loading the TV at `localhost` is also what keeps ±key transpose working**, so on WSL2 the
   `ENCORE_PUBLIC_ORIGIN` route is doubly the right one. The transpose runs through an `AudioWorklet`,
   which browsers only expose in a **secure context** — `https://` or the `localhost` family — and on a
   plain `http://<lan-ip>` origin it fails silently: the buttons move, the labels update, the audio does
   not change. Since the Windows host is usually the machine attached to the TV and reaches core over the
   portproxy at `localhost:3000` anyway, opening `/tv` there gets you a secure context for free while the
   QR still advertises the LAN address. The guiding track is unaffected either way. See
   [`README.md`](README.md) in this directory for the full explanation and the other routes.

   Check it by eye rather than inferring it: the join card on `/tv` prints the URL beneath the QR. If
   that text reads `localhost:3000`, no phone can use it.

7. **End to end:** scan the QR, join with a name and colour, search a song, tap Karaoke, and watch
   `nvidia-smi` during the process. If VRAM usage and GPU utilisation stay flat, the process is running on
   CPU regardless of what anything claims.

8. **Re-measure.** Run the committed stem-separation benchmark on this box and add a CUDA machine to
   its record: the scripts are in `docs/benchmarks/stem-separation/scripts/` (`bench.py`, `run-matrix.sh`),
   and [Reproducing](../benchmarks/stem-separation/README.md#reproducing) gives the commands. No CUDA
   machine is in that record yet, so the model ranking there may not hold on a GPU.

---

## 7. Security: this service has no authentication

Encore has no accounts and no host role. Anyone who can reach port 3000 can join a room, queue songs,
control playback, and change global settings. That is fine on a home LAN and is the product's design —
but it means:

- Keep the firewall rule on the **Private** profile. Do not port-forward 3000 from your router.
- Do not put this on a network you do not control.
- If you ever need remote access, put it behind a tunnel or reverse proxy that does the
  authentication; do not expose it directly. If you do, make the proxy set `X-Forwarded-Host` and
  `X-Forwarded-Proto` — `joinOrigin()` and `publicOrigin()` believe both, and with no address declared
  they are what make the join QR encode the public hostname and `https` instead of the container's own plain-HTTP address.

---

## 8. Autostart

`restart: unless-stopped` is already set on both services, so containers come back on their own —
but only once Docker is running, and under WSL that needs a nudge at logon.

Simplest: enable "Start Docker Desktop when you log in", plus a Task Scheduler task at logon running

```
wsl -d Ubuntu --cd /srv/Encore -- ./dev.sh compose --cuda --profile stems up -d
```

Then stop Windows from sleeping mid-song:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

---

## 9. Rollback

The GPU path lives entirely in the override file, so reverting is dropping `--cuda` (the flag that adds
that `-f`) and rebuilding against the CPU wheels:

```bash
./dev.sh compose --profile stems build worker
./dev.sh compose --profile stems up -d worker
```

Data and media are untouched by this — they live in the volumes from §4, not in the image.

---

## 10. Updating

Three things update independently, and conflating them is how "I updated and it broke" happens.

**The deployment** — new Encore code. `$EC` is the compose invocation you exported in §4:

```bash
cd ~/Encore                       # the WSL-side clone from §3, never /mnt/c
git pull

$EC --profile stems build         # rebuild core + worker against the new source
$EC --profile stems up -d         # recreate the changed containers only
$EC --profile stems ps            # confirm both came back up
$EC --profile stems logs -f --tail=50 worker
```

Migrations apply automatically on core's boot, so there is no separate step. `data/` and `media/`
survive: they are volumes, not image content.

A worker rebuild that invalidates the dependency layer re-downloads the CUDA torch wheels
(`TORCH_EXTRA=cu128`), which is **multi-GB and slow**. When only core changed, name it and skip that entirely: `$EC build core`.

**WSL itself** — see §1. `wsl --version`, `wsl --update`, then `wsl --shutdown`. Do this when
networking misbehaves or a `.wslconfig` key appears to be ignored, not routinely.

**The GPU stack** — the NVIDIA driver is a **Windows** update, never installed inside WSL (§2). The
container toolkit is a distro package:

```bash
sudo apt update && sudo apt install --only-upgrade nvidia-container-toolkit
sudo nvidia-ctk runtime configure --runtime=docker   # re-run if the toolkit's config was replaced
```

After any driver or toolkit change, re-run the §6 GPU gate before trusting a process — the failure mode is
a worker that silently falls back to CPU, and the worker's startup line reading `accelerator=cpu` (§6) on a
box you expect to be `accelerator=cuda` is the tell.

Reclaiming space after several rebuilds, since torch layers accumulate fast:

```bash
docker image prune -f      # dangling layers only — safe
docker builder prune -f    # the build cache; next build is slower but correct
```

Do **not** reach for `docker system prune -a --volumes` here: `--volumes` takes `data/` and `media/`
with it, which is the library and the SQLite database.

---

## Known unknowns

Flagged rather than glossed, because each could cost an evening:

- **`cap_drop: ALL` plus GPU passthrough.** Every service runs with all Linux capabilities dropped
  and `no-new-privileges`. CUDA needs device nodes rather than capabilities, so this _should_ be
  fine, but it is unverified on this stack. If the GPU is invisible inside the container while
  `docker run --gpus all` works standalone, temporarily relax the hardening on the worker to confirm
  that is the cause before changing anything else.
- **Mirrored networking with Docker Desktop.** Both features rewrite WSL networking; their
  interaction is not something this runbook has tested. If phones cannot reach port 3000 under
  mirrored mode, the §1 portproxy fallback is the escape hatch.
- **First-process downloads.** The first `stems` process fetches the separator checkpoint and yt-dlp's
  solver script into `worker-cache`. Expect a slow first song, not a hang.
