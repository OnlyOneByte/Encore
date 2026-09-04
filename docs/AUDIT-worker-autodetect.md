# Worker setup audit — one image, zero env vars

Audit of `apps/worker` as of `origin/main` @ 49fefcc. Goal being tested: **one worker image, and
every hardware-shaped setting auto-detected rather than hand-set.**

Verdict up front: the goal is ~90% reachable, and the missing 10% is not the part that looks hard.
There is already only **one Dockerfile**; the multi-image feeling comes from compose overrides that
*bake env vars*. The genuinely blocked part is narrow and architectural (one pip environment can
hold exactly one torch build), and it is solvable with a multi-arch manifest plus one optional tag.

---

## 1. What the audit found

### 1.1 There is already only one Dockerfile

`apps/worker/Dockerfile` builds every Linux variant. CPU, CUDA and Intel differ by **one build arg**:

```dockerfile
ARG TORCH_INDEX_URL=https://download.pytorch.org/whl/cpu   # Dockerfile:18
RUN pip install --no-cache-dir --extra-index-url "${TORCH_INDEX_URL}" -r requirements.txt
```

This works because `cpu`, `cu128` and `xpu` all publish the *same* pinned version strings
(`torch==2.8.0 / torchaudio==2.8.0 / torchvision==0.23.0`), so no requirements edit is needed.
`docs/deploy/Dockerfile.intel` is a second Dockerfile but is documented as obsolete — native
`torch.xpu` replaced IPEX, and `docs/deploy/README.md` already says it is "kept only as a fallback".

So the image count is not the problem. **The problem is that choosing a variant currently also
means hand-writing a block of env vars**, and those env vars are what makes it feel like a
different product per box.

### 1.2 The env surface is 25 variables; only 2 are irreducible

Everything is read in one place (`WorkerConfig.from_env`, `config.py:190-238`) — a good design that
makes this tractable. Classified:

| Class | Count | Examples |
|---|---|---|
| **Auto-detectable** (machine fact the worker can probe) | 8 | `ENCORE_DEMUCS_DEVICE`, `ENCORE_WHISPERX_DEVICE`, `ENCORE_SEPARATOR_BACKEND`, `ENCORE_DEMUCS_JOBS`, `ENCORE_TORCH_THREADS`, `ENCORE_DEMUCS_SEGMENT`, `ENCORE_WORKER_CAPABILITIES`, `ENCORE_WORKER_ID` |
| **Deployment fact** (cannot be probed) | 2 | `ENCORE_CORE_WS`, `MEDIA_DIR` |
| **Policy already owned by core** | 4 | `ENCORE_ASR_MODEL`, `ENCORE_SYNC_MODE`, `ENCORE_DEMUCS_MODEL`, `ENCORE_ANNOTATE` |
| **Debug / escape hatch** | 5 | `ENCORE_PROCESSOR`, `ENCORE_*_BIN` (3), `ENCORE_LRCLIB_BASE` |
| **Fine-tuning, has a sane default** | 6 | `ENCORE_DEMUCS_OVERLAP`, `ENCORE_DEMUCS_SHIFTS`, `ENCORE_STEM_BITRATE`, `ENCORE_FLAC_LEVEL`, `ENCORE_WORKER_CONCURRENCY`, `ENCORE_WORKER_VERSION` |

Two variables are genuinely irreducible: **`ENCORE_CORE_WS`** (where is home) and **`MEDIA_DIR`**
(which volume core is also using). Everything else can be probed, defaulted, or is already decided
core-side and merely *duplicated* on the worker.

### 1.3 The single highest-value finding: capabilities are typed by hand, not probed

`ENCORE_WORKER_CAPABILITIES` is read as a raw comma string and sent unchanged
(`config.py:206-209` → `protocol.hello`). Nothing verifies the box can actually do what it claims.

This is the bug that already bit this deployment twice: a worker advertising only `stems` leaves
core-enqueued `fetch` and `align` jobs unclaimed, and the song sits at 0% forever — visually
identical to a hung worker. The fix that shipped was to *change the default string*. The real fix is
that **the string should not exist**: the worker can prove each capability by probing.

| Capability | Provable by |
|---|---|
| `fetch:ytdlp` | `yt-dlp` resolvable on PATH **and** a JS runtime present (deno) |
| `stems` | `demucs` importable / on PATH |
| `stems:roformer` | the roformer engine module importable |
| `stems:ensemble` | both of the above |
| `align` | `whisperx` importable |

Two supporting facts make this cheap: `backends.py:24` already has a load-free
`_module_available()` probe, and `vocabulary.py:252` already has a `capability_token()` builder that
composes exactly these strings — **and it is dead code with zero call sites.** The machinery to
derive capabilities was written and never wired up.

### 1.4 Device auto-detection exists but is applied to only one of two consumers

`preferred_torch_device()` (`backends.py:97`) probes `cuda → xpu → mps → None` and is genuinely
good: an *explicit* device that fails its probe **raises** rather than silently running on CPU,
which is the right call.

But it is invoked once, for separation only (`dial_home.py:233`). Alignment has its own device knob
with a hardcoded default:

```python
whisperx_device: str = "cpu"                                    # config.py:160
whisperx_device=e.get("ENCORE_WHISPERX_DEVICE", "cpu"),         # config.py:224
```

So a CUDA box separates on the GPU and then transcribes on the CPU unless a human sets a second
variable. Nothing warns. This is the clearest "auto-detect already exists, just isn't used" gap.

### 1.5 The worker never tells core what hardware it has

`worker:hello` (`events.ts:70`) carries `workerId, capabilities, concurrency, version` — and nothing
about device, backend, VRAM, or core count. `worker:heartbeat` carries only capacity.

Meanwhile core makes the *cost-bearing* decisions (engine, model, ASR model) from `GlobalSettings`
plus a **static** `REFERENCE_BOX` factor (`separators.ts:112`). `estimateCookSeconds` even has a
`hardwareFactor` parameter (`separators.ts:293`) that nothing ever feeds a real value. The worker
computes a perfect `describe()` line with model/backend/device/jobs and only ever **prints it to its
own stdout** (`dial_home.py:150`).

Net effect: core decides how expensive a cook will be while blind to the fleet it is deciding for.

### 1.6 A job no worker can run is parked silently, forever

`hasCapableWorker()` exists in `dispatch.ts:220`, is exported, and is covered by two test files —
**and has zero production call sites.** `planAssignments` just does
`if (!best) continue; // leave queued`. So "no worker has this capability" is indistinguishable
from "all workers are busy", which is precisely the failure mode that reads as a broken worker.

### 1.7 The split of core-side vs worker-side decisions is correct and should not change

Worth stating because the request implies moving things: the current boundary is right.

- **Must stay core-side:** engine, model, ASR model, sync mode, fetcher, lookup keys. These are
  persisted onto `Media.separator` and feed the never-regress upgrade ladder (`isQualityUpgrade`,
  `separators.ts:274`). If workers picked their own, two boxes would publish inconsistent
  instrumentals and the quality ranking would be meaningless.
- **Correctly worker-side:** device, backend, thread counts, `-j`. These do not change output —
  `-j` is documented as a pure scheduling change producing bit-identical stems (`config.py:75`).

The thing to fix is not *where* decisions are made, it is that the worker-side ones require a human
and the core-side ones are made blind.

---

## 2. The one-image question, answered precisely

A single pip environment can hold exactly one torch build. Verified against the live indexes —
`torch 2.8.0`, cp312:

| Index | linux x86_64 | linux aarch64 | macOS arm64 | wheel size |
|---|---|---|---|---|
| `cpu` | ✅ | ✅ | ✅ (**MPS included**) | 175 MB |
| `cu128` | ✅ | ❌ **none** | ❌ | 848 MB (+ ~2–3 GB `nvidia-*` deps) |
| `xpu` | ✅ | ❌ | ❌ | 691 MB |

Three consequences that decide the architecture:

1. **CUDA and XPU cannot coexist.** All three indexes publish the identical version string with
   different build content, encoded in the local version specifier. `pip` installs one `torch`.
   Supporting both in one image means two venvs — roughly +4 GB for zero runtime benefit.
2. **macOS needs no special index.** The `cpu` index's macOS arm64 wheel *is* the MPS-capable
   wheel. Apple support costs nothing extra — and cannot be containerized anyway (no Metal
   passthrough into Linux), so a Mac worker is a native run, not an image.
3. **A CUDA wheel runs fine on a box with no GPU** — `torch.cuda.is_available()` returns `False` and
   everything falls back to CPU. So one *tag* can serve NVIDIA and CPU hosts, if you accept the size.

### The shape that gets closest to "one image"

**One tag, multi-arch manifest, accelerator chosen by architecture:**

- `linux/amd64` → built with `cu128`. Auto-detects at runtime: CUDA on an NVIDIA host, CPU otherwise.
- `linux/arm64` → built with `cpu` (no CUDA wheel exists for aarch64 at 2.8, so there is no choice).
- Docker already resolves this by host arch. `docker pull encore-worker` — no user decision.
- **Intel Arc** stays one extra optional tag, `:xpu`, from the same Dockerfile and same build arg.
  It is the only case a user must choose, it is currently parked, and its host requirements
  (`/dev/dri`, numeric render/video gids) are irreducibly host-side anyway.

Cost, stated honestly: the amd64 image grows from ~1 GB to ~4 GB, paid by CPU-only x86 users who
get no benefit. That is the entire tradeoff. Mitigation if it bites: publish `:slim` (cpu index,
same Dockerfile, same build arg) — but ship the fat default first, because "it just works" is worth
more than 3 GB on a self-hosted karaoke box.

**Precision about why the manifest trick is legitimate here.** A multi-arch manifest list keys on
`os`/`architecture`/`variant` only — it has no field for "has an NVIDIA GPU", and the daemon selects
at *pull* time from static metadata, before anything can run `nvidia-smi`. So manifest lists
generally **cannot** pick an accelerator. It works in our case for a narrow reason: at torch 2.8
there is no aarch64 CUDA wheel at all, so **architecture happens to fully determine the only
available choice**. The same trick cannot separate CUDA from Intel-xpu, because both are
`linux/amd64` and equally valid matches — which is exactly why Intel needs its own tag rather than
another manifest entry.

### The alternative worth knowing about: let `uv` pick the index

`uv pip install --torch-backend=auto` (or `UV_TORCH_BACKEND=auto`) inspects the installed CUDA
driver and selects the matching PyTorch index itself. vLLM ships this as its documented install path.
That would delete `TORCH_INDEX_URL` outright — the accelerator becomes a *detected* fact rather than
a build argument.

Two catches decide whether it's worth it. At **build** time it detects the *builder's* hardware, not
the deploy target, so it only helps if you build on the box you run on — plausible for a self-hosted
box, useless for publishing images from CI. At **container start** time it works properly but makes
every cold start download multi-GB of torch and adds a hard runtime dependency on
`download.pytorch.org` — unacceptable for a party appliance that must boot on flaky wifi.

Verdict: not for the published image. Genuinely useful for the **native** (non-Docker) install path
that the README documents for Mac and bare-metal, where it replaces "figure out which index URL you
need" with one command. Worth adopting there.

**Host-side requirements can never be baked**, regardless of image strategy: NVIDIA driver +
`nvidia-container-toolkit`, Intel kernel driver + `/dev/dri` passthrough, and compose's device
reservations. Auto-detection can *report* these are missing clearly; it cannot supply them.

---

## 3. Plan — DELIVERED

All seven stages shipped on this branch (`audit/worker-autodetect`). They landed together rather than
separately because S7 — deleting the baked env — is only safe once S1–S4 derive what it declared.

Three things the implementation added beyond the plan, all found by building it rather than reading:

- **Blank-safe env reads (`_str`).** Compose plumbs optional overrides as `FOO=${FOO:-}`, which puts an
  *empty string* in the environment. `dict.get(key, default)` sees a present value and returns `""`, so
  an unset override silently became `demucs_model=""` — a worker passing `-n ''` to demucs and failing
  every cook for a reason nothing in the config line would explain.
- **The image's baked `ENCORE_WORKER_CAPABILITIES=stems` had to go.** Harmless as a default; actively
  destructive once the override became narrow-only, because it would have capped *every* container
  built from the image to separation, silently dropping the fetch and align it is perfectly capable of.
  The exact failure the probe exists to remove, reintroduced through the back door.
- **The unservable broadcast needed a playability guard.** An `align` follow-up on an already-published
  song is genuinely unservable, but broadcasting a `queued` status for it regressed a ready song to
  cooking on every phone — worse than the bug being fixed. Missing lyrics is not missing audio. Caught
  by an existing lifecycle test, not by review.

### S1 — Derive capabilities instead of reading them (highest value, lowest risk)

Probe each capability at startup via the existing `_module_available()` and PATH checks, and build
the advertised set with the existing-but-dead `capability_token()`. Log one line per capability with
the reason it was included or excluded. Keep `ENCORE_WORKER_CAPABILITIES` as an override that
**narrows only** — it may subtract from what was proven, never add (claiming an unprovable
capability is exactly the failure this removes).

Kills: the class of bug where a song sits at 0% because nothing can claim `fetch` or `align`.

### S2 — One device resolution for the whole worker

Route alignment through `preferred_torch_device()` instead of the hardcoded `"cpu"`. Fold
`ENCORE_DEMUCS_DEVICE` and `ENCORE_WHISPERX_DEVICE` into one optional `ENCORE_DEVICE` override that
applies to both, keeping the current explicit-never-downgrades semantics. Consider
`torch.accelerator.current_accelerator()` (torch ≥ 2.6, so available on the pinned 2.8) to replace
the cuda/xpu/mps ladder — but keep the per-device probe, because `torch.accelerator` reports
*presence*, not *usability*.

Kills: the silent CPU-alignment slow path on a GPU box, and two env vars.

### S3 — Container-aware sizing

`auto_demucs_jobs`/`auto_torch_threads` read `os.cpu_count()`, which **lies inside a container** —
it reports the host's cores while the cgroup throttles you to two. Add an effective-CPU helper:
`min(os.cpu_count(), len(os.sched_getaffinity(0)), cgroup quota)` guarded for non-Linux. Add a
memory probe (`/proc/meminfo` + `cgroup memory.max`) so `concurrency × jobs` oversubscription can be
*refused* rather than merely warned about. On a GPU device, also read free VRAM
(`torch.cuda.mem_get_info`) and size `--segment` from it instead of leaving peak memory to chance.

Verified on this dev box: 32 logical CPUs, full affinity, no cgroup limits, ~123 GiB RAM, no
accelerator of any kind — so this bug does not bite *here*, which is why it has stayed hidden.

### S4 — Auto worker identity

`ENCORE_WORKER_ID` defaults empty → `"worker-1"` (`dial_home.py:29`). Two unset workers both
announce `worker-1`. Derive from hostname + a short random suffix; keep the env var as an override.

Kills: a silent fleet collision, and one more required variable.

### S5 — Worker reports its hardware on `worker:hello`

Add an optional `runtime` field carrying what `describe()` already computes: device, backend,
effective cores, memory, VRAM, engine availability. The frame already has an unused optional
(`authToken`), so it tolerates additive fields. Store it on `WorkerSession`.

This is what turns `hardwareFactor` (`separators.ts:293`) from a dead parameter into a real number,
lets core warn "the connected worker will take 8 minutes for this model", and makes the internal
metrics dashboard able to attribute a cook to actual hardware.

### S6 — Make unservable jobs loud

Call the already-written, already-tested `hasCapableWorker()` in the dispatch loop and surface
"no connected worker can run this" distinctly from "waiting for a free slot".

### S7 — Collapse the deploy surface

Delete `docs/deploy/Dockerfile.intel` (already documented obsolete). Strip the accelerator compose
overrides down to what is genuinely host-side — GPU device reservation, `/dev/dri`, group ids — and
delete every `ENCORE_*` env line they currently bake, since S1–S4 derive all of it. Publish the
amd64/arm64 multi-arch manifest under one tag, plus `:xpu`. Then rewrite the README worker section:
the target is `docker compose --profile stems up` with `ENCORE_CORE_WS` and `MEDIA_DIR` as the only
knobs a deployer sees.

### After S1–S7

| | Before | After |
|---|---|---|
| Env vars a deployer sets | 6–10 (per-accelerator block) | **2** (`ENCORE_CORE_WS`, `MEDIA_DIR`) |
| Images/tags to choose between | 4 variants + 2 Dockerfiles | **1 tag** (+ `:xpu` for Intel Arc) |
| Capability string | hand-typed, unverified | probed and proven |
| Device selection | baked per deploy | detected, override still available |
| Core's view of the fleet | capacity only | capacity + hardware |

### What stays human input, permanently

Presence is detectable; **sufficiency and intent are not.**

- Whether an available GPU is *big enough* for a checkpoint — only a real load reveals OOM.
- Operator coverage on MPS/ROCm — a device can be available and still lack a needed kernel.
- Driver-vs-userspace version match — a successful import does not prove a kernel will launch.
- The measured optimum for `concurrency` / `jobs` / `overlap` — non-linear in RAM × topology.
- Which engine and model the room wants — an audible taste choice, not a hardware fact.
- Which GPU a worker should claim when several exist — fleet placement, not a probe.
- Network egress reachability (LRCLIB, MusicBrainz, YouTube) — a property of deployment position.

---

## 4. How comparable projects do it

Every project surveyed splits the problem the same way this plan does: **the wheel is chosen at
build/install time, the device is detected at runtime.** Nobody auto-selects an accelerator *wheel*
inside a running container.

| Project | Images | Device selection |
|---|---|---|
| **ollama** | `:latest` serves **CPU + CUDA together**; only AMD gets a separate `:rocm` tag | runtime auto-detect, `*_VISIBLE_DEVICES` to override |
| A1111 webui | none official | `get_optimal_device_name()`: cuda → mps → xpu → npu → cpu, `--device-id` / `--use-cpu` override |
| ComfyUI | none official (third-party per-accelerator tags) | `get_torch_device()`: same probe ladder, `--cpu` forces |
| llama.cpp | **per-accelerator tags** (`-cuda`, `-rocm`, `-vulkan`, `-intel`…) | fixed by which tag you pull |
| faster-whisper / whisperX | none official | **explicit** `device=` parameter, no detection |

Two conclusions. First, **ollama's shape is exactly the architecture recommended in §2** — one
mainstream tag covering CPU and NVIDIA with runtime detection, one odd-vendor tag alongside it —
which is reassuring, since ollama is the project with the closest deployment profile to Encore
(self-hosted appliance, non-expert operators). llama.cpp's per-tag approach is the alternative, and
is what Encore does today.

Second, the projects that require an explicit `device=` are **libraries** (faster-whisper, whisperX),
where deferring to the caller is correct. Encore is the caller. Today the worker passes that decision
straight through to a human via `ENCORE_WHISPERX_DEVICE`; it should be answering it instead. That is
S2.

### B-8 interaction: `python-audio-separator` already auto-detects

Relevant because B-8 plans to adopt it. Its `setup_torch_device()` probes
`torch.cuda.is_available()` → `torch.backends.mps` (+arm) → DirectML (opt-in only) → CPU, with **no
explicit device argument** for the primary selection. So adopting it makes several of Encore's device
env vars redundant with the library's own detection — do S2 *before* or *with* B-8, or the two
detection paths will disagree.

But it also adds a **second accelerator axis**: audio-separator selects an ONNX Runtime execution
provider independently of the torch device, and its `[cpu]` / `[gpu]` / `[dml]` extras swap the
`onnxruntime` wheel (not torch). So "one image" must then satisfy *two* per-accelerator wheel choices
— torch's and ORT's. That does not break the plan, but it means the capability probe in S1 should
report the ORT provider too, and the image matrix decision in §2 must be made for both axes at once
rather than revisited later.

### On `torch.accelerator`

Confirmed as PyTorch's own documented replacement for the probe ladder (`≥ 2.6`; pinned torch is
2.8, so it is available):

```python
device = torch.accelerator.current_accelerator().type if torch.accelerator.is_available() else "cpu"
```

Two caveats that keep S2's per-device probe necessary rather than redundant:
`current_accelerator()` reports the accelerator **compiled into the wheel**, not one proven usable;
and `is_available()` has raised `RuntimeError` when no device is present (pytorch#144567), so it must
be guarded. Use it to collapse the ladder, keep `torch_device_available()` as the usability gate.

Also worth tracking, not acting on: **PEP 817 wheel variants** (draft) would let a variant-aware
installer pick the right per-backend wheel automatically at install time. It does *not* produce a
single fat wheel — the per-backend split is permanent, only the selection gets automated. If it
lands, it replaces the §2 tag matrix entirely.
