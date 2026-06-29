# Karaoke — Performance & Feel ("wicked fast, a blast to use")

Status: **LOCKED** (MVP design)
Thesis: at a party, *perceived* latency and *zero dead air* beat raw throughput. Every tap
must feel instant; songs must flow with no gap. These are the load-bearing decisions.

---

## Tier 1 — the three that define the feel

### 1. Optimistic UI everywhere (the #1 perceived-speed win)
Every mutation renders **locally, instantly**, then reconciles with the server broadcast.
- Tap "Add to my turn" → song appears in the queue *that frame*. No spinner, no wait.
- Client generates the **ULID client-side**, so the optimistic row already has its real id →
  when the server broadcast arrives, it matches by id and there's **zero flicker / no re-sort**.
- On reject (rare): the row animates out with a tiny "couldn't add" toast. Failure is the
  exception path, not the default wait.
- Applies to: queue add / remove / reorder, join, rename. The round-trip happens *behind* a UI
  that already moved.

### 2. In-memory authoritative server state (the backend speed unlock)
The live **queue + playback state live in RAM** as the source of truth. SQLite is **write-behind
durability**, never on the read/broadcast hot path.
- Reads never touch disk. A `queue:updated` broadcast is computed from memory → sub-millisecond.
- Writes update memory → broadcast immediately → persist to SQLite async (write-behind).
- On boot, hydrate memory from SQLite once. This is what makes the realtime loop feel telepathic.

### 3. Gapless next-song preload (the single biggest "blast" multiplier)
The TV **preloads and buffers the next entry** while the current song plays.
- Dead air between songs is what kills every party. Eliminate it: next video `preload`/buffered,
  next local file fetched, crossfade or hard-cut on `ended`.
- Server tells the TV the *next* entry early (`nowplaying:changed` carries `upNext`), so the
  player warms it before it's needed.

---

## Tier 2 — responsiveness

### 4. Diff/patch broadcasts, not full-state
Send `{op:'add', entry}` / `{op:'move', id, toSeq}`, **not the whole queue** every change.
Tiny payloads survive bad party wifi and keep 20 phones in sync cheaply. Full-state sync only
on connect/reconnect.

### 5. Search that reads your mind
- Search-as-you-type, **debounced ~150ms**, **cancel the in-flight request** on each keystroke.
- **Library** results are instant (in-memory/SQLite FTS index).
- **YouTube** results **cached + deduped** by query — re-typing a song is free.
- Surface **recently-queued** + **popular tonight** as zero-keystroke shortcuts.

### 6. WebSocket resilience (party wifi WILL drop)
Heartbeat ping/pong, **auto-reconnect with backoff**, and **full-state resync on reconnect**.
The phone holds its optimistic copy through a blip and never feels "stuck" or stale. A dropped
socket is invisible to the singer.

---

## Tier 3 — the polish that sells it

### 7. Stack: SvelteKit + PWA
- **Svelte compiles away** — no virtual DOM, tiny bundle, fastest first paint of the mainstream
  options. Ideal for mobile-first. (Also: zero ramp — same stack as VROOM.)
- **PWA**: installable, instant warm load, offline app-shell. QR → singing in seconds.
- Svelte 5 runes = fine-grained reactivity; only the changed queue row re-renders, not the list.

### 8. 60fps motion + tactile feedback
- Animate **transform/opacity only** (GPU-composited) — never width/height/top (layout thrash).
- Spring physics on reorder, bottom sheets that **track the finger**, `navigator.vibrate()` haptic
  tick on queue-add. This is the difference between "works" and "a blast."

### 9. Almost no spinners
Optimistic UI (Tier 1) means most actions never show a loading state. Use skeletons **only** where
data genuinely must arrive first (initial search, cold join). Everywhere else: instant.

---

## Backend hot-path checklist
- SQLite in **WAL mode**, **prepared statements**, single writer (in-process — no network hop).
- Never serialize the whole DB on the hot path; memory is the read source (Tier 1 #2).
- **Cache yt-dlp metadata** — never re-resolve the same video id twice.
- Thumbnail proxy with on-disk cache + long cache headers.
- Brotli/gzip + HTTP/2; immutable hashed asset filenames.

## The "watching, not waiting" principle
The worker live-progress bar (`media:status` → `Separating vocals… 68%`) is a *performance-feel*
feature: when a processed song genuinely needs time, turn the wait into a show. Progress that
moves feels 2× faster than a spinner that doesn't.

---

## What NOT to optimize (yet)
- Horizontal scaling / multi-room sharding — one room, one node process is plenty for a party.
- Micro-tuning SQLite query plans — in-memory state means queries aren't the bottleneck.
- Video transcoding ladders — the `<video>` tag + a single processed file is fine for MVP.
Premature scale-out work here buys nothing the party can feel.
