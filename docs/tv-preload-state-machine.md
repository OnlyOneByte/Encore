# Karaoke — TV Gapless Preload State Machine

Status: **LOCKED** (MVP design)
Goal: **zero dead air.** The next song is buffered and ready *before* the current one ends, so
playback flows continuously. This is the single biggest "blast" multiplier and where every
incumbent fumbles.

The TV is a **dumb renderer** — it never decides what plays. The server sends `nowplaying:changed
{current, upNext}` and the TV's only job is to render `current` while **warming `upNext`** in a
hidden second player.

---

## 1. Two players, one swap

The TV runs **two media surfaces**: `A` (foreground, visible) and `B` (background, hidden,
buffering `upNext`). On song end, they **swap roles** — no element teardown, no reload flash.

```
  ┌─────────── visible ───────────┐   ┌────────── hidden (warming) ─────────┐
  │  player A: current song       │   │  player B: upNext, preloaded+paused  │
  └───────────────────────────────┘   └──────────────────────────────────────┘
        on `ended` → swap: B becomes visible & plays, A becomes hidden & loads the new upNext
```

Works for both `playMode`:
- **file** (`<video>`): `preload="auto"`, fetch + buffer to a few seconds, hold `paused` at t=0.
- **iframe** (YouTube): instantiate the next player muted+`paused`, `cueVideoById` (NOT `load`)
  so it buffers without autoplaying. Unmute on swap.

---

## 2. States

```
        ┌──────────┐  queue non-empty / nowplaying:changed
        │  ATTRACT │ ───────────────────────────────────────┐
        │  (idle)  │ ◄──────────────┐                        ▼
        └──────────┘   queue empty  │                  ┌───────────┐
                                    │                  │  LOADING  │ buffer `current` in A
                                    │                  └─────┬─────┘
                                    │                        │ canplay / cued
                                    │                        ▼
                              ┌─────┴──────┐  ended    ┌───────────┐
                              │INTERSTITIAL│ ◄──────────│  PLAYING  │──┐ during playback:
                              │ Next up… X │            └─────┬─────┘  │ when upNext known →
                              └─────┬──────┘                  │        │ warm B (PRELOADING_NEXT,
                                    │ next ready              │        │ concurrent substate)
                                    │ (B buffered)            │ ended & next NOT ready
                                    ▼                         ▼
                              ┌───────────┐            ┌───────────┐
                              │   SWAP    │            │  WAITING  │ "X is still cooking 🔥"
                              │ B→visible │            │ (held slot)│ poll media:status / upNext
                              └─────┬─────┘            └─────┬─────┘
                                    │                        │ next ready OR rotation advanced
                                    └──────────┬─────────────┘
                                               ▼
                                         (new PLAYING)
```

| State | What's on screen | Entered when | Leaves on |
|---|---|---|---|
| `ATTRACT` | Big join QR + up-next ticker, ambient motion | queue empty | first/again-queued song |
| `LOADING` | Brief branded splash / album art (rarely seen) | a `current` set but not yet buffered | `canplay`/cued → `PLAYING` |
| `PLAYING` | Video + `Now singing` lower-third (+ lyric slot) | `current` buffered | `ended` |
| `PRELOADING_NEXT` | *(concurrent w/ PLAYING — invisible)* warming B | `upNext` known & `current` past ~25% | B buffered → ready flag |
| `INTERSTITIAL` | Full-screen `Next up: NAME — SONG` (~2–4s) | `ended` & next ready | timer → `SWAP` |
| `SWAP` | crossfade/hard-cut A→B | interstitial done | new `PLAYING` |
| `WAITING` | `NAME's song is still cooking 🔥 — up next: …` + progress | `ended` & next NOT ready | next ready / rotation advanced |

`INTERSTITIAL` is skippable/configurable (0s = pure gapless hard-cut). Default ~2.5s — it's the
rotation-reveal moment that makes the party feel produced.

---

## 3. Preload trigger logic

```
during PLAYING, on (nowplaying:changed.upNext changed) OR (positionSec / duration > 0.25):
    if upNext exists and B not already warming this mediaId:
        B.load(upNext)                       # file: preload+buffer; iframe: cueVideoById
        mark B.warmingId = upNext.entryId
on B 'canplaythrough' (file) / buffering-done heuristic (iframe):
        B.readyId = upNext.entryId           # this entry is now gapless-ready
```

The server helps by sending `upNext` **as soon as the rotation is known**, not at song end — so
B usually finishes buffering with minutes to spare. The TV reports `bufferedNextPct` in
`tv:telemetry` so the server (and phones) know the next song is gapless-ready.

---

## 4. The `ended` decision (the heart of gapless)

```
on player A 'ended' (or tv-side skip command):
    next = upNext
    if next == null:
        → ATTRACT
    else if B.readyId == next.entryId:        # preloaded & buffered → instant
        → INTERSTITIAL (brief) → SWAP → PLAYING
    else if next.media.stemStatus == 'ready' or playMode resolvable:
        → LOADING (buffer now; short wait)    # missed the preload window
    else:                                      # processed song not ready yet
        → WAITING (held slot)                  # server advances rotation; keep next.rotationSeq
```

**Held-slot contract** (mirrors rotation engine): in `WAITING`, the TV does **not** burn the
singer's turn. The server keeps that entry's `rotationSeq`, advances to the next ready singer,
and slots the cooking song back at the same fairness position once `media:status → ready`.

---

## 5. Telemetry the TV reports up (`tv:telemetry`)

```ts
{
  status: 'attract'|'loading'|'playing'|'interstitial'|'waiting',
  entryId: string|null,
  positionSec: number,
  durationSec: number,
  bufferedNextPct: number,    // how warm B is (0..100) — server/phones show "next: ready ✓"
}
```

Server advances the authoritative `PlaybackState` on the TV's `ended` telemetry (not on a guess),
so playback position and song transitions are driven by **what actually happened on screen**.

---

## 6. Failure & edge handling
- **Buffer underrun mid-song** → brief spinner over the video; do not change state; resume on
  `playing`. (Local files on the same host make this near-impossible; matters mostly for iframe.)
- **upNext changes after B is warmed** (someone reorders) → if new upNext ≠ B.warmingId, re-warm
  B; the old buffer is discarded. Cheap because B was hidden.
- **Skip during PLAYING** → treat as synthetic `ended`; if B ready → instant swap, else LOADING.
- **iframe ad/interstitial from YouTube** → unavoidable in `iframe` playMode; this is a key
  reason processed songs (`file`) feel cleaner and motivate the stem path.
- **Empty queue mid-song** → finish current → ATTRACT (never cut a singer off).

---

## 7. Why two players instead of one
A single element must `load()` a new source on `ended` → network fetch + decode + first-frame
= a visible 0.5–3s black gap. **That gap is the dead air that kills parties.** Pre-warming a
second hidden player moves all that work *before* the transition, so the swap is a single
composited frame. This is the whole trick.
