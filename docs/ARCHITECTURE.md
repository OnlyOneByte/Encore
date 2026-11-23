# Encore — Architecture

> **Status:** living · canonical description of the system as built.
>
> This is the one architecture document: how the system works. The rules a change has to respect live
> beside it, in [`SERVER.md`](SERVER.md), [`FRONTEND.md`](FRONTEND.md), [`TESTS.md`](TESTS.md) and
> [`E2E.md`](E2E.md); subsystem contracts as checkable requirements are in [`arch/`](arch/README.md).
> Open work is tracked in GitHub issues.

## 1. Product and core loop

Encore is a self-hosted karaoke server with two surfaces:

- **Phone remote:** QR join (name + color, no signup), then THREE TABS under one persistent bottom chrome —
  Sing at `/` (search and add), Queue at `/queue` (who is up, and the live controls), Library at `/library`
  (what this room can already sing) — plus one song's detail pushed at `/song/[mediaId]`. One-tap queue,
  singer-owned reordering, and the live controls — transport, ±key, guiding track, lyrics re-pick — on the
  Queue tab's now-playing card. The chrome is a fixed-height now-playing strip above a tab bar; it has no
  expandable state.
- **TV/stage:** attract → lobby → waiting → playing, gapless two-player playback, lower-third,
  lyrics, persistent join card.

The loop is deliberately simple:

> phone queues → server decides rotation → TV renders → server broadcasts truth → phones converge.

Round-robin is by **singer**, not FIFO: everyone's first pick before anyone's second. A song processing
at the front is skipped without losing its fairness position (the **held-slot rule**).

## 2. Deployment and stack

```
┌─ Container 1: encore-core ───────────────────────────────────────┐
│ Bun · SvelteKit/Svelte 5 · Bun.serve HTTP + native WebSockets    │
│ Drizzle + bun:sqlite (WAL) · in-memory authoritative room state  │
│ yt-dlp + ffmpeg · phone UI + TV UI + REST + realtime hub         │
└───────────────────────────────────────────────────────────────────┘
┌─ Container 2: encore-worker ─────────────────────────────────────┐
│ Python · separator · WhisperX · ffmpeg                            │
│ dials home over WebSocket · stems + lyrics alignment             │
└───────────────────────────────────────────────────────────────────┘
```

| Layer   | Choice                               | Constraint it satisfies                                        |
| ------- | ------------------------------------ | -------------------------------------------------------------- |
| Runtime | **Bun 1.3.14**                       | native WS pub/sub, `bun:sqlite`, `Bun.spawn`, one core process |
| UI      | **SvelteKit + Svelte 5 runes**, PWA  | small bundle, fine-grained updates, phone-first                |
| Adapter | `svelte-adapter-bun`                 | SvelteKit handler and WS hub served by `core/server.ts`        |
| DB      | **Drizzle + bun:sqlite**, WAL        | durable index and party state without another service          |
| Worker  | **Python**                           | isolates the multi-GB ML stack from core                       |
| Media   | yt-dlp + ffmpeg                      | source resolution, decode, encode, probing                     |
| Storage | local roots or S3/MinIO `MediaStore` | single-box default, remote-worker seam                         |

**Locked:** do not re-litigate Bun/Node/Deno. Performance comes primarily from the architecture, but
Bun's primitives map directly to it.

Repository shape:

```
core/                       the Bun + SvelteKit app
  src/lib/contract/         realtime contract + pure shared reducers, imported by browser AND server
  src/                      SvelteKit surfaces, the authoritative backend under src/lib/server/
  server.ts                 Bun.serve entry: the SvelteKit handler and the WS hub in ONE process
  drizzle/                  SQLite migrations
  tests/                    unit/ (bun test) and playwright/ (browser e2e)
worker/                     Python worker: encore_worker/ package, tests/, pyproject.toml
docker/                     core and worker Dockerfiles, compose files (base, cuda, intel), .env.example
docs/                       this file, LAYOUT, SERVER, FRONTEND, TESTS, E2E, plus arch/, benchmarks/, deploy/
dev.sh                      local dev runner: core + worker natively, no Docker
```

## 3. Authority and realtime

Core is the single authority for queue and playback. Phones predict and command; TV renders and
reports telemetry; workers report progress and artifacts.

```
phone  ── commands ──► core ── queue/playback/media broadcasts ──► all clients
TV     ── telemetry ─► core
worker ── dial-home job protocol ─► core
```

Important events:

| Event                | Direction     | Purpose                                                    |
| -------------------- | ------------- | ---------------------------------------------------------- |
| `queue:patch`        | core → all    | authoritative diff plus revision and inline media snapshot |
| `queue:sync`         | core → one    | full state on connect/resync, including presence snapshot  |
| `playback:state`     | core → all    | current entry, position, playing state                     |
| `nowplaying:changed` | core → all    | current + up-next; drives TV preload                       |
| `media:status`       | core → all    | processing stage/progress/readiness; `requestedBy` names who asked |
| `singer:presence`    | core → all    | ref-counted online transition                              |
| `player:command`     | phone → core  | play/pause/skip/seek/restart                               |
| `tv:telemetry`       | TV → core     | actual playback position/end/buffering                     |
| `job:*`              | worker ↔ core | assign/accept/progress/complete/fail                       |

### Optimistic reconciliation invariant

> **`client.predict(op) === server.apply(op)` for every mutation path**, including round-robin resequencing.

The mechanism is intentionally small:

1. Client mints a ULID for both the operation and any new queue entry.
2. Client applies the shared `QueueOp` immediately and stores its inverse in a pending-op map.
3. Server validates, applies the **same shared reducer**, increments monotonic `rev`, persists, then
   broadcasts the canonical patch with `causedBy: clientOpId`.
4. Origin clears pending and adopts canonical fields; other phones apply the same patch.
5. Reject applies the stored inverse and shows the reason.
6. Revision gap or reconnect requests `queue:sync`; pending operations rebase and resend
   idempotently.

`core/src/lib/contract/queue/rotation.ts` is imported by both sides. Never fork its logic. Validate every
client field before it reaches state/SQLite — one missing `singerId` once killed the whole server.

### Where the client's copy of that truth lives

The phone's half of the loop above is owned by ONE object rather than by a route.
`core/src/lib/stores/room.ts` holds `RoomLink` and the `room` singleton: the `/api/me` probe, the
`QueueStore`, the `WsClient`, and every field the room broadcasts into — playback, singers, the media
catalog, effective settings, the away set, live process statuses, and the saved library. Surfaces
**subscribe and mirror** the fields they render.

All of it used to be CONSTRUCTED in `core/src/routes/+page.svelte`'s `onMount`, which made a route the owner
of app-wide truth, and that had one consequence which finally forced the move: a component mounted in
`core/src/routes/+layout.svelte` could not read the playback state, because the only thing that knew it was a
sibling route component. Persistent chrome was therefore impossible rather than merely awkward, and the
socket is simply not a property of a route — one phone joins one room once.

Three properties of the owner are deliberate:

- **It is a plain class with an explicit `subscribe`, not a rune-backed `.svelte.ts` store.** A
  module-level `$state` singleton is shared across SSR requests on the server, which is a cross-request
  leak waiting to happen; plain fields that only ever move in the browser cannot leak that way.
  `core/src/lib/stores/queue.ts` beside it already established subscribe-and-mirror and is tested that way,
  so a second idiom in one directory is a thing every reader learns twice. And mirroring per component
  means the strip does not re-render on a library merge it does not read.
- **The socket lives for the DOCUMENT, not the route.** `connect()` is idempotent and browser-only, and
  nothing closes the connection on navigation — the bottom chrome has to survive it, and so does a tab switch.
  `close()`
  exists for a test; the document closing takes the socket with it. A guest who has not joined settles
  with no socket at all.
- **The root layout gates connecting on a not-a-phone list.** `core/src/routes/+layout.svelte` is the ROOT
  layout, so it wraps the television: an ungated `room.connect()` would open a second `role=phone`
  socket on `/tv` — which already holds its own `role=tv` one — and register the television as a singer
  present in the room. The list is deliberately the same four exemptions the phone-route walk already
  enforces, rather than a second opinion about what a phone surface is.

Two seams follow from single ownership, and both are the reason for it rather than a side effect. The
**saved library** is owned here because its one fetch serves two readers: it gives the library section its
rows AND seeds the media catalog and live statuses the QUEUE reads for its titles and progress bars on a
cold load. Sharing one function body inside a route meant the queue's titles depended on the search surface
having run — invisible while they were one file, a silent breakage the moment they were not. And the
held **failed-process scars** must be maintained rather than snapshotted at connect: the link does not
remount, so a failure arriving after connect has to join the held list, or the next `queue:sync`
replaces the catalog and wipes the very row the scar exists to survive a reload.

### The phone's surfaces

Chrome first, because it is what the ownership above bought.

`core/src/lib/ui/NowPlayingStrip.svelte` and `core/src/lib/ui/TabBar.svelte` are mounted together by the layout, inside
one fixed `.dock` wrapper, as the bottom-most chrome of every joined phone surface. The strip carries who is
singing, the song, and the transport; the tab bar carries the three tabs. `position: fixed` lives on the
wrapper rather than on either component, because `/components` renders them standalone to show every state and
a fixed one would collapse those onto the real chrome.

**THE STRIP HAS NO OPEN STATE, and that is the whole point of its shape.** Its height is a function of nothing
but whether it renders, which it does when `hasSong || canStart` — so an idle room shows the tab bar alone
rather than a dead transport. There is no snap array, no drag, and no geometry read inside it.

`--dock-h` is the wrapper's **measured** height, published on documentElement so every scrolling column
reserves it in normal flow. Measured and not derived, and the attempt is recorded because it looked obviously
right: a tab renders 45px against a declared 44, because its icon, gap and label outgrow the 32px that
`min-height: var(--tap)` leaves inside `padding-block` under border-box. The content-driven height is also the
CORRECT behaviour — the chrome holds text, so a height frozen at one tap floor would clip the label at the
browser's 200% text-only zoom. `env(safe-area-inset-bottom)` lives on the TAB BAR alone, the app's bottom-most
element, and reaches everything stacked above it through `--dock-h`; a second `env()` term higher up doubles
the gap.

The live controls — ±key with the vocal range beneath it, the guiding-track level, and the door to lyrics
re-selection — sit on the **Queue tab's now-playing card**, above the queue list. They act on what is PLAYING,
and the playing song is not in the queued list, so putting them below the list would separate a control from
its subject by the whole scroll height of a party's queue. `core/src/lib/components/GuidingTrack.svelte` wraps a
slider that reads `offsetWidth` and must not mount hidden; a route that renders its content unconditionally
satisfies that without the portal-on-open dance a sheet needed.

The routes then divide by the question each answers:

| Surface           | Answers                              | Notes                                                                                                                                                                     |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/` (Sing)        | what can I sing                      | the search field and its results. A guest who has not joined gets the landing state instead                                                                               |
| `/queue` (Queue)  | who is up, and the live controls      | the now-playing card (±key, guiding track, the song-detail door) over ONE list of the rotation — a cooking song still holds its turn, so processing cards interleave        |
| `/library`        | what can this room already sing       | one flat list of ready songs, with sort and facets behind a collapsed disclosure                                                                                          |
| `/song/[mediaId]` | can I sing THIS, are the words right | reached from `/queue`'s now-playing card, the only door to it; shares `GET /api/audit/[mediaId]` with `/metrics/[mediaId]`                                                 |

Three of those are reversals worth recording rather than quietly dropping.

**There is no now-playing sheet on the phone.** The reason is a PRODUCT fact rather than a budget: Encore's
now-playing surface is the TELEVISION. A phone that is a remote and a queue needs a line of text and three
buttons, which is what `NowPlayingStrip.svelte` is; a draggable sheet over the page would need snap points,
pointer-capture and resize handling to stay out of the way of the content beneath it. The live controls sit
on `/queue`'s now-playing card instead.

**The hero is gone.** Home used to open with a card for a song someone else is singing, which spent the
top third of the screen on the one thing a guest cannot act on, pushed the rotation down the page, and —
once the band existed — said "Nothing playing" twice on one screen. Its content moved into the sheet, and
from there to `/queue`'s now-playing card when the sheet went,
which is a change of PLACE and not of content: the same song identity, seek row, transport and live
controls, none of it occupying the queue any more.

**Search is a PLACE you go again — the Sing tab.** FOUR placements now, and each was right about something.
It was a box docked in the thumb zone whose results expanded UPWARD in place over the queue, with no browse
mode and no `?browse=1`, because there was nothing to navigate back out of. The band then took the bottom
edge, so the box moved to a route of its own (`/find`) — once search is somewhere you GO, a route is what
makes the phone's own back gesture the way back. And a route turned out to be the cost: the songs already on
disk, the whole point of persisting the catalog, were invisible from the screen a guest actually sits on.

Then the field moved to the TOP of home and the library under the queue (2026-09-22), which kept both
readings: nothing competed with the band for the bottom edge, and there was no navigation to back out of
because a query simply replaced the queue with the results.

And the fourth placement is the third one's argument taken seriously (2026-10-04). A query replacing the queue
meant the two things a guest does at a party — add a song, check when I am up — fought for one 390x844 viewport
minus the chrome. The tab bar gives search its own place without the `/find` cost, because the library and the
queue are now tabs rather than sections that search had to displace. `$lib/stores/search-focus` is DELETED, not
re-pointed: it existed so the band's magnifier could focus a field inside a route it could not reach into, and
the strip that replaced the band carries no magnifier — the Sing tab is one tap away on the tab bar instead.

Note what did not come back through any of it: there is still no browse TOGGLE, because the library IS the
default content, and results read DOWNWARD, so the best match is first and the scroll-to-the-end
orchestration is gone rather than re-pointed.

`/song/[mediaId]` is a route rather than a sheet, on a forward-looking
argument: lyrics timing and editing are becoming a comprehensive system, and a sheet that grows into a
workspace is the wrong container to start one in — a chooser is not an editor. It **fetches** instead of
reading the link, because the client catalog only holds songs the room has touched and this page is
reachable for any id, including a song processed on an earlier night. It reads the link for exactly the
live fact the audit row cannot know: the room's current `keyShift`, so its range readout describes what
the TV is sounding rather than the song at concert pitch. Nothing has to close itself as it navigates any more:
the chrome it is reached from is a fixed strip that covers nothing, where the sheet it used to live in had to
dismiss or it would have covered the page it had just opened.

## 4. Rotation, presence, and room state

### Rotation

`rotate` / `assignSeqs` / `applyAndReseq` own fairness. Terminal entries (`done`/`canceled`) are
pruned on apply and hydrate. A not-ready file entry is skipped by `isEntryReady` but keeps its
`rotationSeq`, so processing never burns a singer's turn.

WHICH ordering is a room setting (`RoomSettings.queueOrder`), and the registry is
`core/src/lib/contract/queue/queue-order.ts` (built with `makeRegistry`, like every other flat registry): fair
rotation (the default and the pre-setting behaviour),
first-come-first-served, a stable shuffle, and whoever-sang-longest-ago. Adding one is a registry
entry plus one pure function — as long as it needs nothing but the queued entries and `Ordering`.

Three things make this work, and all three are load-bearing:

- **The ordering is threaded, not looked up.** Every function takes an optional `Ordering`
  (`{ order, lastSungAt }`) defaulting to fair, so a caller with no settings to hand behaves as it did
  before the setting existed. The server assembles it in ONE place — `orderingOf(deps)` in
  `realtime/hub.ts` — because a second source is how the server comes to pick a different "next" than
  the queue every client is looking at.
- **The client must know it.** `applyAndReseq` runs on the phone too; predicting with fair rotation in
  a first-come-first-served room puts every add in the wrong place for a frame and then snaps. The
  phone holds `EffectiveSettings` (seeded from `queue:sync`, kept live by `settings:changed`) and hands
  the store a _getter_, so a mid-party change needs no re-wiring.
- **Changing it must reseq the live queue.** Unlike every other room setting, this one is not a
  render-time choice: `rotationSeq` is stored per entry, so `PUT /api/settings/room` calls
  `state.reorder()` and broadcasts a `queue:patch`. `reorder()` returns null when the order is
  unchanged and then touches nothing, which is what makes it safe to call from the playback path too.
  It never interrupts the current song — ordering ranks only `queued` entries.

`least-recently-sung` reads `Singer.lastSungAt`, stamped at song START (their remaining picks should
drop behind everyone else's the moment their turn begins). It lives on the singer, not in `plays`,
because that table deliberately carries no singer id: this records THAT someone sang and when, never
what. With no history the policy is exactly fair, so a party starts identically either way.

A drag-reorder stays policy-agnostic: `reorderWithinSinger` rewrites the stored list, permuting the
singer's own songs among the queued slots that singer already holds, so no other singer's row shifts and
nobody can jump anybody. (`moveToIndex` is the cross-singer sibling, counting every queued entry.) The
phone therefore offers reordering **unconditionally**. It did not always: while rank under `shuffle` was
re-derived from the entry id a move was a legal no-op there, and the arrows were hidden for it. Nothing
re-derives a position now — the stored list is the source of truth — so there is no ordering that can
discard a move.

### Presence

The WS upgrade identifies a singer from the session cookie. `PresenceTracker` is ref-counted and
broadcasts only on 0→1 / 1→0. `queue:sync` carries the current online snapshot. Never infer presence
from the `singers` table — it is persistent and append-only.

### TV screen precedence

The pure `tvScreen()` decision is:

```
playing > waiting > lobby > attract
```

- **attract:** nobody present; full-screen QR.
- **lobby:** people present, no queue; hero QR + roster.
- **waiting:** queued media still processing.
- **playing:** media, lower-third, lyrics, compact join card.

Spatial ownership is contractual: lower-third = bottom-left, join card = bottom-right.

### Stage stacking

Also contractual, and easy to break by accident because the layers live in three different files:

```
0  stage background   (.stage-bg — tv/+page.svelte)
1  hidden player slot (TvPlayer)      ─┐ the gapless pair; the visible one
2  visible player slot (TvPlayer)     ─┘ carries z-index 2
5  attract / lobby glow               (these OWN the idle screens and paint opaque)
6  lyrics overlay · lower-third
7  interstitial · TV progress
8  connection status dot
```

Two consequences worth stating, because both were live defects:

- **Nothing above 0 may paint an opaque background.** `TvPlayer`'s `<video>` used to carry its own
  `background: an earlier change`, which — since a process song has no video track and `object-fit: contain`
  letterboxes — painted the whole screen black and hid layer 0 completely. It is `transparent` now;
  `.tv`'s own black is the floor.
- **The background is shown for the whole playing BAND, not just `screen === 'playing'`.** It is gated
  on the same `!isAttract` flag as the player slots, so it also covers `waiting` (a song is on stage,
  still processing) and the interstitial. Gating it on `playing` alone puts a black flash between every
  song.

### The stage layer can host a renderer, not just a colour

`stageBackgroundCss` resolves a style to a CSS `background` string, which is enough for every colour
option. The `visualizer` style is the exception: a drawing loop is not expressible as a CSS value, so
that case returns `an earlier change` — the **floor** — and a `<canvas>` mounts **inside the same `.stage-bg`
layer**, not beside it. One layer, one visibility gate, one crossfade; a sibling element would have to
be kept in agreement with this one about when to show.

The renderers themselves are **pure functions of time** in `lib/tv/visualizers.ts`; the component owns
only the loop. A canvas inside a `.svelte` file cannot be unit-tested here, and the colour bound below
is enforced by driving those functions against a fake context — so the split is what makes the bound
real rather than aspirational.

Nothing on the TV reads the audio: there is no `AudioContext` on that surface, and no user gesture
anywhere on `/tv` to start one. The visualizers are therefore time-driven, and the registry
**deliberately excludes spectrum bars and an oscilloscope** — those assert they are drawing the signal,
and drawing them from a timer is the defect the lyrics overlay refuses by name ("a lie dressed as
precision"). Adding real analysis means adding a `MediaElementAudioSourceNode` per `<video>`, which
must reach `ctx.destination` or the song goes silent.

**Motion budget.** This is the second `requestAnimationFrame` loop on the TV — `LyricsOverlay` already
interpolates position telemetry to 60fps, and the lyric ball has the stronger claim. So the visualizer
caps at ~30fps, renders to a half-scale backing store, and cancels its frame when the stage is not
shown. `prefers-reduced-motion: reduce` draws one still frame and stops.

### Colour tiers

Two OKLCH tiers, both generated by `hueToHex` in `core/src/lib/contract/presentation/colors.ts`, and the split is a
legibility bound rather than taste:

| tier   | L / C       | used for                                                                                                     |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------ |
| singer | 0.70 / 0.16 | the singer dot — small fill on a dark card, needs 3:1 non-text                                               |
| stage  | 0.22 / 0.07 | the `singer` glow and the visualizer palettes — **derived** TV colours, sitting **behind word-timed lyrics** |

`stageHueToHex` additionally ramps lightness down toward 0.13 as a hue closes on `--accent2`'s hue
(345°, the "sing this now" active word) over a 60° band. Without it a pink singer's stage and the
active-word highlight are the same hue family and the cue stops reading. The ramp is continuous
rather than a threshold, so adjacent wheel stops cannot get wildly different stages.

Raising either tier's lightness regresses the lyrics. Tests assert the bound (white clears 4.5:1, the
active pink clears 3:1, on all 24 wheel stops) rather than any literal hex.

**The stage tier no longer bounds the room's own colour**. The room used to store a hue angle
and every stage went through `stageHueToHex`, which made the tier an inescapable legibility bound. That
bound is gone, and the job it was doing moved onto the thing it protected: the lyric reel
paints its own `-webkit-text-stroke` outline, which holds on any field _and_ over a music video,
which a bound on the stage colour could never reach. So `RoomSettings.tvBackgroundColor` is a real hex
rendered verbatim — a room may pick white — while the tier still governs every colour nobody chose by
hand, because an unasked-for bright field has no explanation. `hueOfColor` recovers an angle from the
stored hex for the visualizers, which build their palettes by hue arithmetic.

## 5. Gapless playback

TV owns two media surfaces: A is visible/current, B is hidden/warming `upNext`. Core sends up-next as
soon as rotation knows it, so B normally has minutes to buffer. On `ended`, TV reports telemetry and
swaps to B; it does not decide the next queue entry itself.

```
ATTRACT → LOADING → PLAYING ── ended ──► INTERSTITIAL → SWAP → PLAYING
                         └─ next not ready ─► WAITING ─► next ready/rotation advances
```

Every surface is a `<video preload="auto">` loading a separated instrumental. There is no second
player: nothing plays unprocessed, so there is nothing to embed. If up-next changes, B rewarm starts
for the new entry. Skip is a synthetic `ended`. Switching the room's **Song intro** off gives a pure hard-cut; default is
the short singer-reveal moment.

Implementation: `core/src/lib/tv/gapless.ts`, `TvPlayer.svelte`, server `realtime/player.ts`.

## 6. Media identity and storage

### Identity

`sourceRef` is **immutable origin identity**. Processed playback lives in `Media.instrumentalRef`, and
players call `playbackRef(media)`. Never overwrite `sourceRef` with an artifact path: doing that made
a result unmatchable against its own future searches and minted duplicate unprocessed rows.

### Playability

**Nothing plays unprocessed.** A song is playable when it has a separated instrumental, and not
before — no YouTube embed, no singing over the original vocals, and a local library file is a process
candidate like any other source rather than a special case.

`playbackRef` returns `''` for anything unprocessed and `isPlayable` is defined in terms of it, so "what
do I load" and "is there anything to load" cannot disagree. Both require a `ready` status **and** an
`instrumentalRef`: the two are written by separate steps, and a status running ahead of its artifact
would hand the player an empty source. `listReady` mirrors the same rule, so a browse row can never
resolve to a file that is not on disk.

This replaced a `playMode: 'iframe' | 'file'` column that encoded two questions at once — is this ref
a playable file, and has it been processed — leaving two sources of truth for playability. `stemStatus` +
`instrumentalRef` already answered the second; the first stopped existing when the embed path did.

Readiness therefore has three honest states: `ready` (processed), `processing` (a job in flight, rotation
holding its slot), and `unacquired` (nothing to play yet). The third used to mean "playable as-is,
with the original vocals", which is why it was renamed rather than reworded.

### Search sources

A query with no `?source=` asks the **default set** — `ytmusic` + `local` + `spotify` — and `?source=`
narrows. The phone has no picker for it: `Not it? Search everything` sends `?source=all`, and the Sing tab passes
its own `/?source=` through for testing one source:

| Source    | What it searches                                    | In the default set?                                                        |
| --------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| `ytmusic` | YouTube Music's catalog (`songs` filter, InnerTube) | **yes** — catalog rows: the real artist and the track duration              |
| `local`   | files on this box (a disk-scan FTS index)           | **yes** — the user's own media, and it is in no other index                 |
| `spotify` | Spotify metadata only — never acquirable            | **yes** — clean canonical artist/title as an annotator                      |
| `youtube` | all of YouTube, keylessly via `yt-dlp ytsearch`     | **no** — reachable as `?source=all` or `?source=youtube`                    |

**Plain `ytsearch` is not in the default.** What that buys, measured: the real performer instead of a
channel name ("The Black Eyed Peas", not "Tasty"), the track duration instead of a video length, and a
median **459 ms against 1628 ms** — `ytsearch` spawns a yt-dlp subprocess, and on one probe it was killed
at its 10 s timeout and returned nothing where `ytmusic` answered.

What it costs, also measured — and the first draft of this section overstated the case, so the correction
is worth keeping. An initial sweep of 18 hard queries "returned a usable hit for every one", but that sweep
had **no negative control**, and the `songs` filter *never returns empty*: `zzzzzzznotasongzzzzzz` answers
with "A Million Laughing Emoji's". It measured "did rows come back", not "did the right song come back".
Against a SPECIFIC upload the catalog substitutes a catalog entity — `bohemian rhapsody live aid 1985 full`
leads with a 148 s studio-soundtrack cut where `ytsearch` finds the actual performance.

**That is why the phone's widen affordance is not gated on an empty result.** A narrowed default whose
escape hatch only appears when nothing matched has no escape hatch at all, because nothing-matched is a
state this default cannot reach. `?source=all` adds `ytsearch` back.

The default is a SET rather than simply `?source=ytmusic` because of `local`: those are the user's own
files, they live in a disk-scan index rather than the catalog, and narrowing to a single source would
silently hide them.

`ytmusic` results are tagged `source: 'youtube'`, deliberately: a music hit IS a YouTube video id, so
the same video found both ways collapses to one library row (origin identity is `source` + `sourceRef`),
and the fetcher, thumbnail derivation and retention all already speak that identity. Where a hit was
FOUND is not part of what it IS. InnerTube is unofficial, so every field read is defensive and a
reshaped response degrades to an empty result — `safeSearch` already treats a dead source as a miss.

### Metadata provenance

A YouTube title is not metadata. `Media.artist` holds whatever the source reported — often a channel
name like "Music of All Times" — so two derived fields carry what the song actually is:
`artistCanonical` and `titleCanonical`. They exist because the LRCLIB query matches on
`artist_name` + `track_name`, and library browse groups by artist.

They are filled in two tiers, and `Media.annotation` records which:

| Source        | Means                          | Set when                                                      |
| ------------- | ------------------------------ | ------------------------------------------------------------- |
| `normalizer`  | a title parse and nothing more | search materialises a result, gated on `confidence !== 'low'` |
| `musicbrainz` | a citation, with an `mbid`     | a `fetch` job identified the download                         |

**Refusing is the design.** A wrong artist is worse than a missing one: it silently poisons the lyrics
query that consumes it, and afterwards it is indistinguishable from a correct one. So a lookup with no
confident artist/title does not happen, a MusicBrainz match must AGREE on both names after
normalisation rather than merely score well, and duration decides confidence (±2s → `high`, ±5s →
`medium`, beyond → nothing written). ±2s is not arbitrary: it is the tolerance LRCLIB itself matches
on, so a `high` annotation is by construction good enough for the lookup that consumes it.

**Never regresses.** Once a media holds a `high` citation, a later `medium` cannot overwrite it — a
re-fetch or a backfill would otherwise turn a known-good artist back into a guess. A `normalizer` value
is always overwritable, because a citation beats a parse even at medium confidence.

That rule needs memory, so the citation persists in all three layers: DB columns (the runtime catalog
hydrates from the index synchronously at boot, before the async sidecar pass), the sidecar's
`canonical.mbid` + `provenance.artist` (authoritative), and only ever as a complete source+confidence
pair. A sidecar write also refuses to downgrade a citation back to a re-parse of the raw title — the
same regression, reintroduced through persistence.

Album and year are deliberately **not** taken from MusicBrainz. Measured against the real service they
resolved "Take On Me" to a 1991 hits compilation and "Bohemian Rhapsody" to an undated bootleg, because
a search hit's release list is partial and the recording is chosen by duration, so a live cut matching
the file's length brings its own release with it. A trustworthy album needs a second release-group
lookup.

### Storage classes

Split by **replaceability**, which makes backup and eviction policy obvious:

| Class   | Default root         | Contents                                     | Policy                          |
| ------- | -------------------- | -------------------------------------------- | ------------------------------- |
| state   | `DATA_DIR`           | SQLite index, queue, singers, playback, jobs | small; back up                  |
| audio   | `ENCORE_AUDIO_DIR`   | native downloaded originals                  | unrecoverable; never auto-evict |
| derived | `ENCORE_DERIVED_DIR` | stems, pitch, lyrics                         | regenerable; first to evict     |
| meta    | `ENCORE_META_DIR`    | authoritative sidecar JSON                   | tiny; portable; back up         |

Refs remain portable relative strings whose first segment selects the root:

```
audio/<id>.<ext>
derived/stems/<id>-instrumental.flac
derived/stems/<id>-vocals.flac
derived/stems/<id>-guidemix.flac
derived/pitch/<id>-pitch.json
derived/lyrics/<id>.json
meta/<id>.json
work/<jobId>/
```

`meta/<id>.json` is authoritative; SQLite is a rebuildable index. Sidecars preserve raw source
metadata, canonical metadata with provenance/confidence, artifact refs, tags, and play history. IDs,
not titles, name files. `safeMediaPath` performs containment per root.

### Audio policy

- Raw audio keeps YouTube's native container — no useless lossy→WAV transcode.
- Worker decodes transiently for separation; `work/<jobId>` is deleted by the **worker** that owns it.
- Instrumental is **16-bit FLAC**: the file heard at volume gets no second lossy generation.
- Vocals are **16-bit FLAC** (they were AAC 192k): they feed ASR and pitch analysis AND are played
  to the room as the guiding track, so they get the same no-second-generation treatment. Sharing one codec
  with the instrumental is also what makes the two decode to a sample-exact common start.
- The **guide mix** is both stems in ONE 4-channel FLAC (ch 0/1 instrumental, ch 2/3 vocals), split apart
  in WebAudio on the TV. It exists so the guiding track shares the instrumental's playhead and cannot
  drift; two media elements are two clocks and cannot be sample-locked from script. Written whenever the
  separation produced a vocals stem, and best-effort: a failed guide-mix encode publishes the stems alone
  (`worker/encore_worker/steps/separate_steps.py`). It roughly DOUBLES a song's derived stem bytes, which is
  the cost of the guarantee.
- Demucs emits 44.1 kHz; removing explicit `-ar 44100` is hygiene, not a sample-rate change.
- Stereo is the source ceiling; a 5.1.2 receiver upmixes it.
- `ENCORE_MEDIA_MAX_GB` is an optional soft cap; eviction is derived-only, true-LRU.

Measured migration: old per-song storage ~108 MB → ~14–21 MB depending on FLAC complexity; live
`derived/` fell from 911 MB to 136 MB without dropping library songs. The guide mix adds roughly the two
stems again, so a song that has one costs ~28–42 MB of `derived/` — **re-check `ENCORE_MEDIA_MAX_GB` after
enabling it**, since eviction is whole-song and crossing the cap costs a full re-separation to undo.

## 7. Worker and job lifecycle

Workers **dial home** to core, advertise `capabilities` and `concurrency`, and receive jobs over WS.
The durable SQLite ledger deduplicates `(mediaId, jobType)`.

```
queued → assigned → running → ready
   ▲         │          │
   └─ timeout/reject ───┘ (attempt++, retry until max)
                          └─ nonretryable/exhausted → failed
```

- Ack lease: assignment must be accepted in 10s.
- Progress lease: running job must report at least every ~30s.
- Reaper requeues expired jobs; boot resets orphaned `assigned`/`running` to `queued`.
- Priority is the earliest `rotationSeq` needing that media, not FIFO.
- Acquisition is its own job. A process starts at `fetch`, which chains to `stems` through
  `followUps()`, so a separation is never dispatched before its input exists. A local media skips
  acquisition: its bytes are already on the volume.
- A completed `stems` job enqueues `align` through `followUps()` — it needs the vocals stem, so
  starting it before separation would race and contend.
- Core flips media refs/status only after the worker completes and artifacts exist.

### The attempt ledger — history, as opposed to state

The `jobs` row above is the **dispatch slot**: exactly one live row per `(mediaId, jobType)`, mutated
in place. That shape is what makes dedup correct, and it is also why it can hold no history — a retry
reuses the row, so there is nowhere to put a second attempt. It carries `createdAt` and `updatedAt`
and nothing else, and `updatedAt` is overwritten by every progress frame.

`job_attempts` is the other half. One row per attempt, opened when the job enters the queue and
sealed at its outcome; once sealed it is never written again, and a retry opens a new row. It carries
**four clocks** — `enqueuedAt`, `assignedAt`, `startedAt`, `finishedAt` — because one cannot separate
time spent waiting from time spent working, and each is null until that moment actually happens (a job
nothing picked up has no start, and 0 there would invent work). It also carries the **resolved**
engine/model/backend/device and asrModel/syncMode, which cannot be re-derived later: they resolve from
operator-editable global settings at dispatch, and a worker may resolve something different again.

`processingId` groups the steps of one run. `mediaId` cannot: a song may be processed more than once (a failure
frees the dedup slot; `stems-upgrade` re-separates a finished song), so grouping by media blends
distinct runs and makes an end-to-end duration meaningless. `stems-upgrade` deliberately starts a NEW
process — it is background work on an already-finished song, and folding a 43-minute upgrade into a process
that delivered a singable song in 90 seconds would make every end-to-end average a fiction.

The ledger is **observability and never a failure mode**: it is optional on the repository, and a
lifecycle event with no open attempt is a no-op rather than a throw, so deploying it with jobs in
flight does not fail on the first completion. The worker measures per-stage wall clock from the
progress stream it already emits (so no processor contains timing code) and reports it, plus what it
actually ran, on `job:complete` — all additive optional fields, so an older worker still completes.

`plays` is the same idea for performances: the sidecar's `playCount` remains the authoritative
lifetime total, but a counter has no time axis, and `queue_entries` is wiped on every flush and on
boot. One row per play, deduped on `entryId` by a unique index so a restart cannot double-count the
song that was on screen.

A worker accepts a job when it advertises a capability that serves the job's **action**, matched on the
action prefix rather than as a literal string. Both axes namespace their capabilities — `stems:roformer`
for an engine, `fetch:ytdlp` for a downloader — so a literal comparison rejected work the worker could
genuinely run. That bug made every acquisition bounce with "unsupported job type: fetch" while the core
kept the job `assigned` and the song sat at 0%, which reads like a hung download rather than a refused
assignment.

The worker's stems path is orchestration, not numeric computation: it builds argv, spawns tools, and
parses progress. This is why separator engines can change behind the `Separator` protocol (`worker/encore_worker/adapters/ports.py`).

### Where audio comes from: the fetcher axis

A job **declares** how to obtain its source audio; nothing infers it. `JobParams.fetcher` is `ytdlp`
(download it) or `local` (it is already a path under the media volume), and the worker parses that at
its boundary, so an unknown fetcher raises before a byte moves.

This replaced shape inference. The core used to emit either a watch URL or a bare file key, and the
worker recovered the intent by testing for an `http(s)` prefix — in three places. A ref matching neither
assumption, such as `spotify:track:…`, was silently classified as a local file and died stages later
inside ffmpeg with "No such file", naming the symptom and hiding the cause. `local` is therefore a
first-class fetcher rather than an absence: "already here" is exactly the case the old test got wrong.

`fetch` routes on `fetch:<fetcher>` rather than on `stems`, so a box that can pull audio and a box that
can separate it need not be the same machine. That is what makes a credentialed fetcher droppable later
without touching dispatch; `local` carries no capability because there is nothing to route.

The registry in `core/src/lib/contract/process/fetchers.ts` whitelists what is possible so a stored setting can be
validated and a picker rendered from one source; the _choice_ is a setting, not a per-request argument.

A `fetch` finishes by **identifying** what it downloaded (see §6 Metadata provenance). Annotation is a
step rather than its own job because it needs exactly what a download produces and nothing a separate
job would add: the real title and the exact duration. It is best-effort by construction — a declined
match, an unreachable service, or `ENCORE_ANNOTATE=0` all leave the normalizer's values in place and
never fail the process. A karaoke night must not stop because a metadata service is down.

MusicBrainz calls pass through one **process-global, serialised** gate. The documented limit is one
request per second per source IP, and the penalty is total rather than partial: exceeding it declines
_every_ request with 503 until the rate drops. A per-client interval check is therefore not enough —
two clients in one process, or two concurrent fetch jobs racing an unlocked timestamp check, produce
exactly the burst that gets an IP refused. The gate serialises, retries a 503 with bounded exponential
backoff, and runs off the event loop so a paced wait cannot stall another job's progress reporting and
expire its lease.

### Separator engines, models, and backends

Separation is selected along three independent axes:

| Axis        | Chosen by  | Meaning                                                           |
| ----------- | ---------- | ----------------------------------------------------------------- |
| **engine**  | the room   | which algorithm family — `demucs`, `roformer`, `audiosep`         |
| **model**   | the room   | which checkpoint within that engine, from a fixed whitelist       |
| **backend** | the worker | how that engine executes on this box — `torch`, `mlx`             |

Engine and model are audible choices and live in room settings, broadcast to every client. Backend is
a property of the hardware a worker happens to run on and is never user-visible: the same `demucs`
engine runs through PyTorch on a Linux box and through MLX on Apple Silicon, producing the same stems.

A worker advertises a **capability token** per engine it can run, and dispatch routes a job by that
token, so a heterogeneous fleet works without the core knowing anything about hardware. A
demucs/torch worker advertises exactly `stems`, which keeps single-capability workers unchanged;
other combinations extend the token per **engine** (`stems:roformer`). The backend the engine
runs through is deliberately absent from the token — it is a property of the box, not a routing
choice, per the rule above — so an MLX worker running demucs still advertises `stems`, not `stems:mlx`.
(`stems:melband-mlx` is a different MODEL in `worker/encore_worker/adapters/registry.py`, not the demucs
backend.)

Backend selection lives in `worker/encore_worker/host/hardware.py` (`resolve_backend`). Unset, it picks
`mlx` on Apple Silicon when `demucs_mlx` is importable and `torch` otherwise. `ENCORE_SEPARATOR_BACKEND`
always wins when set, and a value outside `torch`/`mlx` raises at startup (`host/config.py`).

The device is a separate choice from the backend: `ENCORE_DEVICE` wins when set, otherwise the probed
accelerator (`cuda` or `mps`) or `cpu`, resolved once in `worker/encore_worker/__main__.py` (`device_for`)
so separation, alignment and diarization share it. `docker/compose.intel.yaml` targets an Intel Arc GPU as
the torch device `xpu`; it is parked, and blocked on there being no `xpu` extra in `worker/pyproject.toml`.

### What the worker measures, and what it is told

The boundary is deliberate and runs one way: **the core decides what a process produces, the worker decides
how its own box executes it.**

Core-side, because these are persisted onto `Media.separator` and feed the never-regress upgrade ladder
(`isQualityUpgrade`): separator engine, model, ASR model, sync mode, fetcher, lookup keys. If workers
chose their own, two boxes would publish inconsistent instrumentals and quality ranking would mean
nothing.

Worker-side, because they change throughput and not output, and only the worker can see them: device and
backend (see above). The accelerator is **probed, not assumed** (`hardware.probe()`): `cuda` or `mps` only
when torch is importable and reports it available. The transcriber's device goes through
`transcriber_device` in `worker/encore_worker/adapters/ml.py` because CTranslate2 accepts only `cpu` and
`cuda`, so an Apple box separates on its accelerator and still transcribes on the CPU.

**Capabilities are proven too** (`hardware.capabilities()`). Each token is backed by a probe — `yt-dlp` on
PATH → `fetch:ytdlp`, `whisperx` importable → `align`, `pyannote.audio` → `diarize`, and, only when ffmpeg is
on PATH, demucs (or `demucs_mlx` under the `mlx` backend) → `stems`, the `bs-roformer-infer` CLI →
`stems:roformer`, `mlx_audio` → `stems:melband-mlx`, `audio_separator` → `stems:audiosep`. The resolved set
is printed at startup. A box claiming work it cannot do is what leaves songs at 0% forever, which is
indistinguishable from a hung worker. The gates are tabulated in
[`arch/05-worker.md` §9.1](arch/05-worker.md#91-what-each-capability-gate-is-proving).

The worker also reports hardware **up**: `worker:hello` carries an optional diagnostic `host` (`WorkerHost`
in `core/src/lib/contract/core/events.ts`: platform, accelerator, device name, torch version, and more),
kept on the worker's registry entry (`core/src/lib/server/jobs/registry.ts`) and summarised in the hub's
join log line. The worker also sends `backend` and `device`, which core neither types nor stores. Every
`host` field is optional, so a probe failure omits it rather than failing the handshake.

Symmetrically, the core now says when it cannot place work: a queued job whose capability no connected
worker advertises is logged by name via `hasCapableWorker`, and flagged `unservable` on `media:status`
when the song is not already playable — a stalled `align` follow-up on a published song is left alone,
because missing lyrics is not missing audio. Before any job exists, `queue:sync` carries `canMake`, one boolean
(no worker ids, hosts or counts): whether connected workers offer `stems` at the room's quality and `align`.
It turns true the moment a capable worker joins and false only after the last one has been gone 10 s
(`MAKER_GRACE_MS`). Boot counts as a loss, so a core restart doesn't flash "can't make" while the worker redials,
and a box with no worker says it 10 s after boot. Each flip re-sends the room a `queue:sync`.

### Settings scopes

Settings live in two layers, split by **who a setting belongs to**:

| Scope      | Belongs to                          | Examples                                                                                                          |
| ---------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **global** | the deployment and its worker fleet | default separator engine + model, upgrade policy, the source **fetcher**, the join address                        |
| **room**   | one party                           | interstitial pacing, a downward-only process-quality ceiling, TV progress + stage background, lyrics presentation |

Separator policy is global rather than per-room because an engine is only usable if some connected
worker advertises its capability — a fact about the server's hardware, not about a party. Two rooms
on one core cannot meaningfully disagree about whether a RoFormer worker exists. The fetcher is global
for the same reason plus one more: it depends on the box's binaries and credentials, so a room cannot
choose a downloader its workers cannot run. `local` is never a legal default — it describes one media's
bytes, so storing it would mean "never download anything" — and the normalizer degrades it on **read**
as well as write, which is also what a de-whitelisted value needs.

The room layer is keyed by room id, so multi-room is a row per room rather than a migration. A room
may only cap process quality **downward** (`maxQualityRank`): the global choice is already bounded by
what the fleet can run, so letting a room raise it would name an engine no worker advertises and the
job would sit queued forever. `resolveProcessSeparator` applies that rule.

Both layers are authoritative server state. A write to either broadcasts `settings:changed` carrying
the combined payload, and `queue:sync` includes both for mid-party joiners — a client never merges
two events to learn the effective state.

### The third lifetime: ephemeral per-song overrides

`global` and `room` are both _persistent_. Three fields on `PlaybackState` are a third lifetime that is
neither — they override the room's choice for the **current song only**, with `null` (or `0` for
`keyShift`) as the resting value meaning "defer to the room": `keyShift`, `background` and `guideLevel`.

- **`keyShift`** — ± semitone transpose for the current song, written by the `key` command handler in
  `realtime/player.ts`, gated on the song's stems being ready (there is nothing to re-pitch before
  separation) and clamped to ±`MAX_KEY_SHIFT`. Covered by `keyshift.test.ts`.
- **`background`** — the TV stage look for the current song, written by the `background` command handler
  (`realtime/player.ts`, `state.setPlayback({ background: cmd.style })`). The style is whitelisted
  (`isTvBackgroundStyle`), with `null` accepted explicitly as "hand the song back to the room default"
  and any other value ignored rather than rejected, because it is a cosmetic control and a malformed
  frame must not tear down the socket. The TV resolves `playback.background ?? room.tvBackgroundStyle`.
  Covered by the dedicated `background.test.ts` suite.
- **`guideLevel`** — the per-song guiding-track (retained-vocals) level, written by the `guide` command
  handler, gated on `hasGuidingTrack` (a song with no vocals stem has nothing to turn up) and clamped,
  with `null` again meaning "defer to the room".

Each field rides `playback:state`, and each is cleared per song. **That clearing is the trap.**
`PlaybackState` is a long-lived singleton — nothing rebuilds it per song — so every ephemeral field is
cleared by being _named_ at each of three `setPlayback` sites in `realtime/player.ts` (song advance,
play-from-idle, `reconcileOnReady`). A field missed at any one of them silently leaks the previous
singer's choice into the next turn, and the type checker cannot catch it. All three fields are named at
all three sites; the two nullable ones reset to `null` (INHERIT, the room default) rather than to a
concrete value, so a room that wants a permanent faint guide does not lose it at every song boundary.
Adding a new ephemeral field means editing all three sites.

### Quality ladder and upgrades

Engine+model pairs carry a declared quality rank, mirrored in the shared contract and the worker. A
completed process can chain a `stems-upgrade` that re-separates from the **retained raw audio** — no
re-download — and the swap is refused unless the new artifact strictly outranks the published one.
`Media.separator` records what produced the current instrumental so that comparison is possible. An
unranked pair scores zero and can never win, so an unknown or de-whitelisted model cannot displace a
known-good artifact.

### 7.1 What each action actually runs

`stems` / `stems-upgrade` and `align` are DBOS workflows (`worker/encore_worker/workflows/durable.py`); only
align's steps are checkpoints, so an align retry resumes at its step while a stems retry separates again.
`fetch` runs directly, one download whose
retry is cheaper than its bookkeeping. The worker's layers, steps and invariants are
documented in [`arch/05-worker.md`](arch/05-worker.md).

## 8. Lyrics

Lyrics separate **text acquisition** from **timing**:

- Text sources split by ROLE, not by quality. A **candidate** is authored text claiming to be the song's
  words — trustworthy about words, untrustworthy about _which recording_, because a lyrics database holds
  one record per release and they all match the same artist+track. A **baseline** is evidence of what is
  actually audible in this audio: never authoritative, but about the right recording by construction,
  which is the one property every authored source lacks.
  - Candidates: LRCLIB records, uploader-authored captions, reserved manual tier.
  - Baselines: local transcription of the vocals stem, local transcription of the raw mix, YouTube's
    automatic captions.
- **The mean of the baselines picks the winner.** Every candidate — and every alternate version of it — is
  scored against every baseline that can speak, and the composite is the unweighted mean. One baseline is
  a single opinion with its own blind spots; three with independent failure modes make a steadier ruler.
  Weighting is deliberately absent: nobody has measured a per-baseline coefficient.
- **Abstention, not zero, is what makes a weak baseline safe.** Agreement is `null` below
  `MIN_TOKENS_TO_COMPARE`, so a baseline that transcribed to almost nothing simply does not vote. That
  covers the two measured failures: a silent vocals stem (2 of 9 on this library shipped as `ready`), and
  YouTube's automatic captions collapsing a song into `[Music]` markers (absent or useless on 3 of 5
  uploads probed).
- **Two local transcriptions, not one.** The stem gives better words when separation worked; the mix is
  the only baseline that still speaks when it did not. Their errors are largely independent, which is what
  makes averaging them worth the second pass.
- **Machine-translated caption tracks are refused outright.** A Spanish song's captions can be offered
  translated into English: as a baseline that text is fluent, long enough to clear the compare floor, and
  about the right song in the wrong language — so it would not abstain, it would vote confidently against
  every correct candidate. Ranking it last is not enough when it is the only track present.
- **Automatic captions are a baseline and never a candidate.** As a source of record they are dangerous —
  ASR wearing a caption's clothes, made from the mixed audio, worse than this worker's own transcription of
  an isolated stem, and rankable as authoritative. As a baseline the same text is just a third opinion. The
  two kinds arrive from separate yt-dlp fetches into separate directories, because yt-dlp names them
  identically and a single directory would leave the distinction to a filename guess.
- **Selection is comparative; the threshold is absolute; both run.** Argmax needs no threshold, which is
  why it separates two versions that both score far above the wrong-song cutoff (measured: 0.548 for the
  wrong version against 0.938 for the right one, cutoff 0.25). The threshold then answers a different
  question — is even the winner about this song — and when it says no, the best baseline is published
  alongside so the room gets words that ARE about this audio rather than only a warning on words that are
  not.
- Timing source: one WhisperX force-alignment layer for any text source.
- ASR transcription yields segment/line bounds, **not word timings**; `align()` supplies words.
- Only what is PUBLISHED gets aligned. Grading five candidates against three baselines costs fifteen
  token-set intersections and no alignment; a trustworthy winner publishes alone, so the common run costs
  exactly one alignment.
- Candidates are retained with source, timing fidelity, confidence, language and creation time;
  `pickBestLyrics()` chooses without destroying upgrade paths. The artifact key carries a **tag** as well
  as source and timing, because a source is no longer one text — two baselines are both `asr` and two
  caption tiers are both `captions`, and without it the second write of a pair destroys the first.
- **A text identified as another song ranks below every honest guess** (`lyricsRank` tier 1). Demoting its
  confidence alone left it tied with the baseline that convicted it, and the tie-break then preferred it,
  because a suspect candidate carries a numeric agreement while a baseline carries none. Publishing the
  baseline is only worth something because the suspect now loses to it.
- Authoritative text + line timing still ranks above a baseline + word timing: correct words with coarse
  highlighting beat wrong words with polished animation.
- Provenance is visible: auto-transcribed lyrics must not masquerade as authoritative.

Live scoring was removed (see DECISIONS, "Deferred"): it compared mic pitch against a reference pitch curve, which
is not how any credible karaoke system scores, and a phone mic in a loud room cannot support the
claim. A redesign is scoped but unbuilt.

## 9. Performance model

The load-bearing choices are architectural:

1. **Optimistic UI:** every mutation renders locally this frame.
2. **In-memory authoritative room state:** broadcasts never wait on a DB read.
3. **Gapless preload:** dead air is removed by warming the next player early.

Supporting rules: diff broadcasts on the hot path; full sync only on connect/gap; search debounce +
cancel + cache; heartbeat/reconnect/resync; transform/opacity-only motion; skeletons only where data
must arrive first. A moving worker progress bar turns unavoidable processing into watching rather
than waiting.

Do not prematurely optimize multi-node scale, SQLite query plans on non-hot paths, or transcoding
ladders. One room and one core are the intended default.

## 10. Security boundaries

Keep these intact:

- Thumbnail proxy: HTTPS-only + host allowlist (SSRF boundary).
- `/media`: per-root path-containment checks through `safeMediaPath`.
- Session token: unique index; singer identity comes from the cookie, not client claims.
- yt-dlp: query is one argv element, with a kill timer — never shell-concatenate user input.
- Containers: non-root, `no-new-privileges`, `cap_drop: [ALL]`, pinned base/dependencies.
- Workers dial home; core does not need inbound reachability to arbitrary worker hosts.

Known and accepted, not an oversight:

- **There is no operator identity.** The only auth axis is anonymous vs _any_ singer holding a session
  cookie, which any device on the LAN obtains by POSTing `/api/join` with a name. So a "joined singer"
  check is a liveness check, not an authorization one.
- Consequently `/metrics`, `/api/metrics` and `/api/audit/*` ship **ungated**. They expose worker ids,
  resolved model/backend/device names, host details and terminal error strings — no singer identities
  and no media bytes. `PUT /api/settings` has the same property and higher stakes: any joined phone
  can change the separator engine and which Whisper weights the fleet loads.
- The honest fixes are a shared secret (`ENCORE_ADMIN_TOKEN`), binding those routes to a trusted
  interface, or a real host/operator concept that closes both. Gating these is open work.
- `/stats` and `/api/stats` are public **by design** and are aggregate-only. This is structural rather
  than a filter: the `plays` table has no singer column, so no per-singer figure can be served from it
  even by mistake.
