# Vocal Guide — design spec

> **Status:** proposed (M8 scoring-adjacent). **Recommends Approach A** (real-time two-track mix).
> **Author:** OnlyOneByte. Grounded in the code at HEAD `0da9685` (v0.2.0).

## 1. Goal

Let a singer **tune how loud the original vocals are** on a make-karaoke (file) song — from
0 % (pure instrumental, today's behavior) up to a faint **vocal guide** (e.g. 15 %) for a song
they don't quite know, up to 100 % (sing-along). Controlled live from the phone, applied instantly
on the TV, per song, with no re-encoding and no extra storage.

This is the natural payoff of stem separation: Encore already computes the isolated vocals during
Demucs separation and **throws them away** — the guide is mostly a matter of *keeping* them.

## 2. What exists today (grounded)

| Fact | Location |
|---|---|
| Demucs runs `--two-stems=vocals`, emitting **both** `vocals.wav` and `no_vocals.wav`, but the processor publishes only the instrumental and discards vocals | `apps/worker/src/demucs.py:51,190,196` |
| `JobArtifacts.stems` **already types** an optional `vocals?: string` — the wire contract is ready; nothing writes it | `packages/shared/src/events.ts:75-78` |
| On `job:complete` the core flips the media to the instrumental key via `markMediaReady` and ignores `artifacts.stems.vocals` | `apps/core/src/server/jobs/worker-hub.ts:132-141`, `apps/core/src/server/jobs/make-karaoke.ts` (`markMediaReady`, `instrumentalKey`) |
| The TV plays **one** `<video>` element for a file song, `src` resolved via `keyedMediaRef(sourceRef, keyShift)`; it owns position/ended telemetry | `apps/core/src/lib/tv/TvPlayer.svelte:26-50` |
| `PlaybackState` carries `{ currentEntryId, positionSec, isPlaying, keyShift }`; `keyShift` is the precedent for "phone tweaks a param → TV re-selects/re-mixes audio" | `packages/shared/src/types.ts:39-44` |
| The `'key'` player command clamps an absolute target and only applies to a stems-ready file song; `setPlayback` bumps `rev` and broadcasts, `setPosition` (ephemeral telemetry) does **not** bump `rev` | `apps/core/src/server/realtime/player.ts:78-90`, `apps/core/src/server/state/store.ts:58-71` |
| The phone's key control (`NowPlaying.svelte`) is the UI idiom the vocal-guide slider mirrors (greyed until stems ready, `onkey` → absolute target) | `apps/core/src/lib/components/NowPlaying.svelte:14,42-46` |

**Takeaway:** the data model, the wire contract, and the control pattern already exist. The feature
is (a) stop discarding vocals, (b) add one continuous `vocalGuide` param that mirrors `keyShift`, and
(c) teach the TV to mix a second, synced track.

## 3. Approach — A (real-time two-track mix), with a low-risk v1 tier

Two families were considered (see §11 for the rejected one):

- **A. Real-time mix** — publish the vocals stem; the TV plays instrumental + vocals together and
  scales the vocals gain live. **Continuous 0–100 %, instant, zero extra storage.** ✅ chosen.
- **B. Pre-rendered guide-level variants** (`-guide.25.wav`, …) selected by filename like keyed
  variants. Trivial but **discrete levels, storage multiplies, and multiplies again against
  `keyShift`**. Rejected as the primary path (kept as a fallback idea in §11).

Within Approach A there are two fidelity tiers. **Ship A1 first.**

### A1 — synced second media element (recommended for v1)

The instrumental stays the **master** `<video>` element exactly as today — it keeps owning
`play/pause`, `currentTime`, `ended`, and all telemetry that drives the gapless state machine
(`tv-preload-state-machine.md`). The vocals become a **secondary `<audio>` element** that
*follows* the master:

- `play/pause` mirrors the master (same `$effect` that already gates the master).
- `vocalsEl.volume = vocalGuide` — that's the whole "how loud are the vocals" knob. No
  `AudioContext`, no `GainNode`.
- A lightweight **drift governor**: on the master's `ontimeupdate` (~4 Hz, already wired), if
  `|vocalsEl.currentTime − masterEl.currentTime| > 40 ms`, snap `vocalsEl.currentTime` to the
  master. Perceptually seamless; no full-buffer decode; seek/restart "just work" because both
  elements are driven off the same commands.

✅ Lowest risk, preserves the entire existing player state machine, delivers the feature.
⚠️ `.volume` is a perceptual mix, not sample-exact; two elements can drift by tens of ms between
governor corrections (inaudible for a backing-vocal guide).

### A2 — WebAudio graph (fidelity upgrade, later)

Route both stems through one `AudioContext` (`MediaElementAudioSourceNode → GainNode → destination`,
or decoded `AudioBufferSourceNode`s started at a shared `context.currentTime` for sample-exact lock).
Needed only if we later want perfect lock or effects (reverb, ducking). Bigger change; deferred.

> The earlier verbal recommendation ("go straight to a WebAudio graph") is **downgraded here**: A1
> gets the same UX at a fraction of the risk. A2 is the upgrade, not the starting point.

## 4. Architecture (A1)

```
                       phone slider (0..1)
                              │  player:command { cmd:'vocalGuide', level }
                              ▼
   core/realtime/player.ts ── clamps, setPlayback({ vocalGuide }) ── rev++ ── broadcast playback:state
                              │
                              ▼  (rev-based sync, reconciliation-contract.md)
   TV TvPlayer.svelte
     ┌───────────────────────────────────────────────┐
     │  master <video>  src=/media/<keyed instrumental>│  ← owns clock + ended + telemetry (unchanged)
     │        │ play/pause, currentTime, ended         │
     │        ▼ drift governor (nudge on >40ms)        │
     │  vocals <audio>  src=/media/<vocals key>         │  ← follows master; volume = vocalGuide
     └───────────────────────────────────────────────┘
```

## 5. Contract & data-model changes

### 5.1 `PlaybackState` — add the continuous param (`packages/shared/src/types.ts`)

```ts
export interface PlaybackState {
  currentEntryId: string | null;
  positionSec: number;
  isPlaying: boolean;
  keyShift: number;
  vocalGuide: number; // 0..1 — original-vocal level mixed under the instrumental. 0 = pure karaoke.
}
```

- Default `0` everywhere `keyShift: 0` is defaulted (store init, `advance`, `play`) — a new song
  **resets the guide to 0** (pure karaoke), same lifecycle as `keyShift`
  (`player.ts:46,59`, `store.ts:16`).
- Add `clampVocalGuide(x)` beside `clampKeyShift` (clamp to `[0,1]`, non-finite → 0).
- Persistence: mirror `keyShift` in `db/schema.ts` + `state/persistence.ts` if playback is persisted.

### 5.2 New player command (`packages/shared/src/events.ts`)

```ts
export type PlayerCommand =
  | …
  | { cmd: 'key'; semitones: number }
  | { cmd: 'vocalGuide'; level: number }; // ABSOLUTE target 0..1, clamped server-side
```

### 5.3 Vocals stem key (`apps/core/src/server/jobs/make-karaoke.ts`)

Add `vocalsKey(mediaId) => stems/<mediaId>-vocals.wav`, parallel to `instrumentalKey`. This is the
`/media/` ref the TV loads for the vocals track (served by the same route/`MediaStore` as the
instrumental — object-store presign path included, `media/object-store.ts`).

## 6. Worker change — stop discarding the vocals (Step 0, free)

`apps/worker/src/demucs.py`:

- Add `demucs_vocals_path(out_dir, model)` → `<out_dir>/<model>/vocals.wav` (parallel to
  `demucs_no_vocals_path`).
- After publishing the instrumental, move `vocals.wav` to the deterministic vocals key and include
  it in the artifact:
  ```python
  yield CompleteResult(
      media_uri=final,
      artifacts={"stems": {"instrumental": final, "vocals": vocals_final}},
  )
  ```
- Pure-helper unit tests only (path builder + the artifact now carries `vocals`) — mirrors the
  existing pure/IO split; no torch needed for the test. The real two-stem run already produces
  `vocals.wav` (confirmed in the M7-C5 real-ML verification), so this is a keep-not-compute change.

> **Step 0 is independently valuable:** M8-C1 (pitch extraction) needs this exact isolated vocal
> stem. Publishing vocals pays for both features.

## 7. Core changes

- **worker-hub `#onComplete`** (`worker-hub.ts:132`): pass `msg.artifacts?.stems?.vocals` into
  `markMediaReady` so the media records a `vocalsRef`. Add `vocalsRef?: string` to `Media`
  (`types.ts`) — a nullable field, absent → no guide available (graceful, see §9).
- **`player.ts`**: new `case 'vocalGuide'` mirroring `'key'` — apply only when the current media is
  a stems-ready **file** song **and** has a `vocalsRef`; `setPlayback({ vocalGuide: clampVocalGuide(cmd.level) })`
  → `rev++` + broadcast. No-op otherwise (a YouTube iframe song has no stems to mix).
- Reset `vocalGuide: 0` in `advance` and the `play` cold-start (alongside `keyShift: 0`).

## 8. TV player changes (`TvPlayer.svelte`)

- Accept `vocalGuide: number` and `vocalsRef: string | null` props (fed from `PlaybackState` +
  `Media`, same wiring as `keyShift`).
- When `media.playMode === 'file'` **and** `vocalsRef` present: render the secondary
  `<audio bind:this={vocalsEl} src={/media/${vocalsRef}} preload="auto">`.
  - `$effect`: mirror master `play()/pause()` (extend the existing active/visible effect).
  - `$effect`: `vocalsEl.volume = clamp(vocalGuide)`.
  - Drift governor inside the existing `onposition` handler: nudge `vocalsEl.currentTime` when it
    drifts > 40 ms from the master; on `seek`/`restart` the master jumps and the next tick re-syncs.
  - On `ended`/swap, tear down the vocals element with the slot (crossfade unaffected — vocals ride
    the same slot lifecycle).
- **keyShift interaction (v1 policy, §10):** the vocals track is key-0 only; when `keyShift !== 0`
  the guide is muted (`vocalsEl.volume = 0`) and the phone control is disabled with a hint.

## 9. Fallback / graceful degradation

- **No vocals stem** (older song separated before Step 0, or a worker that only advertised
  instrumental): `vocalsRef` absent → the phone slider is greyed (exactly like the pre-stems key
  control), the TV renders no vocals element. Never a hard failure.
- **Vocals fetch fails on the TV** (`onerror` on the `<audio>`): drop to pure instrumental, leave
  the master untouched. The song never breaks because of the guide.

## 10. The `keyShift` interaction (the one real hard edge)

`keyShift` selects a **pre-rendered pitched instrumental** (`keyedMediaRef`, `pitch.py`). The vocals
stem is only rendered at key 0. Playing a `+2` instrumental under key-0 vocals is musically wrong.

**v1 policy (ship this):** the guide is available only at `keyShift === 0`. Transposing mutes/greys
the guide; returning to 0 re-enables it. Simple, honest, no new rendering.

**Later options (pick when demand appears):**
1. Also pre-render keyed **vocals** variants (`variants_to_render` already generalizes — point it at
   the vocals file too). Storage doubles the keyed matrix; guide then works at any key.
2. A2 WebAudio phase-vocoder AudioWorklet pitch-shifts the key-0 vocals live to match `keyShift`.
   Highest fidelity, most work.

## 11. Rejected / deferred alternatives

- **Approach B (pre-rendered guide levels):** discrete steps, storage × levels × keys. Only
  attractive if a target TV can't run two media elements — kept as an emergency fallback, not the
  plan.
- **A2 WebAudio graph first:** correct end state, wrong starting point — A1 delivers the UX now.

## 12. Reconciliation & rev semantics

`vocalGuide` is **authoritative playback state**, so it goes through `setPlayback` (bumps `rev`,
broadcasts `playback:state`) — never through the ephemeral `setPosition` path. This honors the
existing invariant (`store.ts:58-71`, and the "ephemeral telemetry must not churn rev" finding):
the guide changes rarely (a human dragging a slider), so rev churn is a non-issue, and every client
converges on the level via the normal rev-based sync (`reconciliation-contract.md`).

## 13. Testing strategy

- **Worker (pure):** `demucs_vocals_path` builder; `CompleteResult.artifacts.stems.vocals` present.
- **Shared:** `clampVocalGuide` (range, non-finite → 0); `PlaybackState` default includes
  `vocalGuide: 0`.
- **Core (`player.ts`):** `vocalGuide` command clamps + bumps rev + broadcasts; **no-op** on a
  YouTube song, on a song without `vocalsRef`, and (v1) when `keyShift !== 0`; resets to 0 on
  song change and cold-start `play`.
- **Core (worker-hub):** `#onComplete` threads `artifacts.stems.vocals` → `Media.vocalsRef`.
- **TV (eyes-on):** slider at 0 → pure instrumental; at ~0.15 → faint audible guide; at 1.0 →
  full vocals; drift stays inaudible across a full song; seek/pause keep the two tracks together;
  transposing greys the control.

## 14. Proposed roadmap items (M8, scoring-adjacent)

`vocals-stem` is a shared prerequisite of both the guide and pitch-extraction, so it lands first.

- **M8-C0** worker publishes the isolated **vocals stem** (`artifacts.stems.vocals`).
  *Done-when:* unit — `CompleteResult` carries a `vocals` key at the deterministic path;
  the existing real two-stem run already writes `vocals.wav`. *(Unblocks C1 pitch-extraction too.)*
- **M8-C5** `vocalGuide` in the contract + core (`PlaybackState`, `clampVocalGuide`, `'vocalGuide'`
  command, `Media.vocalsRef` from `job:complete`).
  *Done-when:* unit — command clamps/bumps rev/broadcasts; no-ops on iframe/no-vocals/transposed;
  resets on song change.
- **M8-C6** TV two-track mix (A1: synced `<audio>` + `.volume` + drift governor + fallback).
  *Done-when:* eyes-on — guide is audible and continuous; drift inaudible over a full song;
  seek/pause stay locked.
- **M8-C7** phone vocal-guide slider (mirrors the key control; greyed until stems ready & key 0).
  *Done-when:* eyes-on — dragging the slider moves the TV vocal level live; disabled states correct.

Future (only if wanted): keyed vocals variants **or** the A2 pitch-shift worklet to allow the guide
while transposed; A2 WebAudio graph for sample-exact mixing/effects.

## 15. Rollout

1. **Step 0 / M8-C0** — publish vocals (tiny, free, also feeds pitch extraction). Ship anytime.
2. **M8-C5 → C6 → C7** — contract/core, then TV mix, then phone slider. Each is independently
   verifiable; C6/C7 are the eyes-on gates.
3. Guide ships **key-0-only**; revisit transpose-compat and A2 later on demand.

## 16. Open questions

- Should the guide level **persist per singer** (a singer who always wants 15 %), or reset per song?
  v1 resets per song (matches `keyShift`); per-singer memory is an M9-Accounts add-on.
- Default level for a freshly-ready song — `0` (pure karaoke) is the safe default; a "suggest a
  faint guide for unfamiliar songs" heuristic is a later nicety.
- One shared room-wide level (current design, matches the single authoritative `PlaybackState`) vs
  per-device — room-wide is correct for a TV everyone watches.
