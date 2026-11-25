# UI tenets

The owner's brief for Encore's UI: **fun to use, easy to understand, and most of all fast.** The seven tenets below
turn that into rules a UI change can be held to. They are in priority order: when two conflict, the higher one wins.

Each tenet has a rule, what it means on the phone and on the TV, the tradeoff it makes ("we choose X over Y"),
and the checks a reviewer runs. The checks that a PR answers line by line are in
[`UI-CHECKLIST.md`](UI-CHECKLIST.md); the visual rules (contrast, spacing, type) are in
[`UI-DESIGN.md`](UI-DESIGN.md).

**About the numbers.** Every "today" figure was measured on `main` at `91865dfe` in headless Chromium on
localhost. Read them as floors, not as what a phone does on Wi-Fi. A target marked **unmeasured** has no number yet,
and a target marked **calibrate** must be measured on `main` before anything fails on it.

## 1. A tap answers in the next frame

**Rule.** Whatever you tap changes on screen at once, before the server has replied.

- **Phone:** the + turns into "queued", the tab lights, the key steps. The server confirms afterwards; if it
  refuses, the change rolls back with one line saying why ([`FRONTEND.md`](FRONTEND.md): an optimistic value may
  not move on a drop).
- **TV:** there is nothing to tap. A phone's tap shows up on the TV in under 100 ms (an add appears as "Up next"
  in 46 ms today).
- **We choose** showing it now and rolling back on the rare refusal **over** waiting for the server to agree.
- **Checks:**
  - Tap to first visible change is at most **100 ms**, at CPU 1× and 4×. Today + to "queued" is 40 ms (31–82),
    33 ms at 4×; a tab switch is 68–71 ms.
  - No control looks live while doing nothing. A tap that can't act says so in place, never a dead tap.

## 2. The room never waits on the software

**Rule.** Every moment on the night has a time budget ([the table below](#speed-budget)). The only waits allowed
are the ones that carry the room, and each of those is ruled: a deliberate, named pause.

- **Phone:** opening the app, joining, searching and adding a song all fit their budgets on a mid-range phone. A
  wait that usually ends in under 300 ms shows **nothing**: no spinner, no skeleton. A longer one shows a
  placeholder shaped like what is coming. A wait past 3 s says in words what is happening (3 s before "Can't reach
  the party").
- **TV:** audio starts under the "Now singing" card within 300 ms, so there is no dead air. The lyrics reel holds
  60 fps during a song on the TV the room actually uses.
- **We choose** fewer bytes and fewer round trips **over** richer payloads (`queue:sync` went from 810 KB to 28 KB
  for this). We also choose a deliberate pause (the 2.5 s handoff card) **over** a faster cut that leaves the room
  unsure whose turn it is.
- **Checks:**
  - Each moment the PR touches stays inside its row of the speed budget. A regression is the branch's median
    above `main`'s maximum, the rule of [checklist item 9](UI-CHECKLIST.md#motion-checks).
  - **No indicator flashes:** a spinner or skeleton is either never painted or stays on screen for at least
    300 ms. The pattern already exists: `PENDING_GRACE_MS = 300` in `core/src/lib/stores/room.ts`.
  - Every deliberate timer on a budget moment is listed in the [deliberate waits](#deliberate-waits) with its
    reason. A new one needs the owner's ruling.

## 3. Nothing moves that you didn't move

**Rule.** The screen holds still under your thumb and your eyes. Motion only explains a change, and it never
delays the content.

- **Phone:** the dock stays one height. The queue holds still when your song starts. A card arriving from another
  phone settles in and never shoves the row you were about to tap.
- **TV:** the lyrics never jump. The "Now singing" card fades in and out over the stage. Nothing new draws over a
  word.
- **We choose** a short, plain fade or settle **over** a showy transition, and a cut **over** any motion that adds
  a wait.
- **Checks:**
  - **CLS 0** on every state change, at 390×844 and 320×568 (checklist items 5 and 9, and the `dock-cls` probe).
    A layout-shift waiver is judged by its cause, not its count.
  - Durations are tokens only: 120, 250 or 400 ms (checklist item 3). **Nothing runs longer than
    `--motion-slow` (400 ms), and no content is held invisible for longer than `--motion-base` (250 ms).** The two
    ruled exceptions are the TV attract phrase (600 ms, on a screen nobody is acting on,
    `core/src/lib/tv/TvAttract.svelte`) and the handoff hold.
  - Only `transform` and `opacity` animate, and reduced motion cuts (checklist items 4 to 6).

## 4. One glance, one next step

**Rule.** Each screen has one obvious thing to do next, in guest words, readable in one glance on the smallest
phone.

- **Phone:** at 320×568 the next action (Sing, your On deck controls, Try again) sits above the fold and above the
  dock without scrolling, or the page brings it to you. There is one accent-filled primary action per screen
  ([`UI-DESIGN.md`](UI-DESIGN.md) §4). No menus a guest doesn't need, no jargon, no explainer paragraphs.
- **TV:** it is always obvious whose turn it is and what is next. During a song the TV shows only the singer, the
  song, who is next and how to join.
- **We choose** removing a step **over** explaining it, and automatic **over** configurable.
- **Checks:**
  - At 320×568 the primary action's box lies between the header and the dock's top edge. There is no horizontal
    overflow (`scrollWidth ≤ clientWidth`). Ruled copy is never ellipsised: it wraps to two lines at most, with
    no orphaned last word.
  - At most **25 words** above the fold on any guest screen, not counting song titles and names (**calibrate**).
    Labels follow [`UI-DESIGN.md`](UI-DESIGN.md) §5.

## 5. Every screen tells the same truth

**Rule.** The TV and every phone say the same true thing, and every bad moment offers the next move.

- **Phone:** a status says only what has really happened ("Making karaoke" once making has started). A failure
  has Try again or Pick another, never a dead end. A lost link says it is reconnecting and doesn't throw you out.
- **TV:** it doesn't announce a turn nobody can hear. A second TV says "The TV is reconnecting...". When a song
  fails, the TV says whose song it was and moves on within 8 s.
- **We choose** a plain, slightly later truth ("Taking longer than usual") **over** a confident guess that might
  be wrong.
- **Checks:**
  - A live screen equals a reloaded one.
  - Screens disagree for at most **1 s**. The phone's "You're up" and the TV's "Now singing" land within **1.5 s**
    of each other (34 ms apart today).
  - Every failure state renders a next action (the `p21-no-dead-ends` probe).

## 6. The TV is a stage you read from the couch

**Rule.** Big, plain, few. The TV is for the room, not for the software.

- **TV:** big words under a moving ball, readable from across the room. Plain ASCII only. No setup text, no source
  labels and no key names during a song. One copy of each fact on screen.
- **Phone:** this tenet doesn't apply, except that a phone opening `/tv` gets a muted copy, never a second stage.
- **We choose** fewer, bigger things **over** completeness. The host's information goes to Settings or the
  empty-room screens.
- **Checks:**
  - The smallest TV type tier is at least **27 px** at 1920×1080, and nothing goes under 24 px (`gate:measured`
    CLAIM 5, a spec in `core/tests/playwright/specs/gate/`). The lyric line is 3.121 rem, about **91 px**.
  - Chrome stays inside `--tv-safe-x` / `--tv-safe-y` (48 px / 5vw, 40 px / 6vh) for overscan (`gate:measured`
    CLAIM 15 at 1920×1080, the empty room and a song; other states from the 1920×1080 frame).
  - The plain-ASCII guard (`core/tests/unit/lib/tv/stage-words.test.ts`) covers every string the TV can render.
  - Rule of thumb for distance: text about 1/200 of the viewing distance tall, so about 15 mm at 3 m. 27 px is
    about 13 mm on a 43" 1080p set and 17 mm on a 55". **Small TVs are at the edge**, so the floor must not go
    lower.

## 7. Fun belongs to the room, not the chrome

**Rule.** Delight lives in the moments that matter on the night: the singer's turn and the room cheering them on.
It never costs a frame, a word or a wait.

- **Phone:** one tap to cheer, and a buzz and "You're up" when it is your turn. Otherwise the phone stays quiet.
- **TV:** the "Now singing" moment, and cheers rising in the singer's lane.
- **We choose** delight in motion that carries meaning **over** decoration, and a switch the host can turn off
  ("Reactions on TV") **over** something always on.
- **Checks:**
  - Every new animation's PR says what it tells the room. If the answer is "nothing", it is cut.
  - A fun feature never fails tenets 1 to 6. Its rows pass checklist item 11 (overlap 0, blank 0 at 6× throttle),
    and its frames never cover a lyric.

**What fun means here.** Karaoke is fun when the room is loud for the singer and the singer feels the moment is
theirs. The software is fun when it disappears into that: the TV shows the room's energy and the phone gets out of
the way. Fun is not badges, confetti or scores (scoring is a non-goal). It must never cost speed (no delight adds a
wait on a control's path; the handoff hold is the one ruled exception), clarity (nothing covers a lyric or adds
words to a guest screen, and loud things can be switched off) or stillness (delight moves on the TV stage, never
under a guest's thumb).

## Speed budget

Each target is for **the slowest phone people bring**, which the measurement approximates as headless Chromium at
CPU 4× on localhost. Wi-Fi adds a round trip that is not measured here. "Today" is `main` at `91865dfe`, median
(min–max) in ms.

**Which rows are gated.** `gate:measured` (`core/tests/playwright/specs/gate/measured-speed-*.spec.ts`) holds the
best of 5 reps at **CPU 1×** for the rows below marked **gated**: open `/` cold and open the QR (1000 ms, their target, but
held at 1×: the target is set at 4×, so a green CLAIM 9 does not mean the 4× target is met), reload a
joined phone and a joined phone opening `/queue` (500 ms), TV `/tv` cold (1000 ms) (CLAIM 9), and tap Sing (+)
(CLAIM 10, ≤ 100 ms, with the dock tabs, On deck's key and Try again). The **4× column is reported, never gated**:
printed in the gate output and attached to the run, and checked on a quiet machine or by the reviewer's A/B run,
because a throttled page on a shared, loaded box swings 2–3× between runs. The CSS and JS each route ships is gated too
(CLAIM 13, gzipped; `/` 19.6 + 122.4 KB, `/queue` 22.2 + 142.9 KB, `/tv` 20.6 + 130.6 KB today, with about 3%
headroom); a PR that shrinks a route lowers its budget in the same PR. The bundle carries only the slice of the
palette registry the app reads (`palette-slice.ts`), not the generator's whole record, which saved about 4.9 KB per
route (#1246). Every other row is reported by the PR that touches it, measured on `main` and on the branch.

| Moment                                              | Target                                    | Today (1×)       | Today (4×)    | Notes                                                                      |
| --------------------------------------------------- | ----------------------------------------- | ---------------- | ------------- | -------------------------------------------------------------------------- |
| Open from the QR (`/?room=CODE`) → name field ready | ≤ 1000 ms at 4×                           | 205 (170–245)    | 673 (646–797) | CLS 0. **Gated** at 1× to 500 ms; 4× reported                              |
| Open `/` cold → code box ready                      | ≤ 1000 ms at 4×                           | 176 (160–448)    | 684 (608–708) | **Gated** at 1× to 500 ms; 4× reported                                     |
| Reload a joined phone → Sing box ready              | ≤ 500 ms                                  | 127 (84–154)     | –             | **Gated**                                                                  |
| A joined phone opens `/queue` → heading ready       | ≤ 500 ms                                  | 164 (156–196)    | –             | **Gated**                                                                  |
| TV `/tv` cold → room code and QR                    | ≤ 1000 ms                                 | 112 (100–160)    | –             | **Gated**. LCP 784 ms is the attract phrase's ruled 600 ms fade            |
| Join: tap Start singing → Sing box ready            | ≤ 300 ms                                  | 136 (105–149)    | –             | dock at 162 ms                                                             |
| Kept phone: tap Start singing → Sing box ready      | ≤ 300 ms                                  | 263–297          | –             | `probe/keep-me`, timed from the test process at load ~70; one tap, no name |
| Search: last keystroke → first library result       | ≤ 300 ms                                  | 205 (175–259)    | 275 (214–279) | 150 ms of that is the debounce in `core/src/routes/+page.svelte`           |
| Search: default sources (catalog and YouTube)       | ≤ 1000 ms on real Wi-Fi                   | **unmeasured**   | –             | 188 (179–277) with the resolvers stubbed; real network unmeasured          |
| Tap Sing (+) → button reads "queued"                | ≤ 100 ms                                  | 40 (31–82)       | 33            | optimistic. **Gated** at 1×; 4× reported                                   |
| Tap Sing → row on your own `/queue`                 | ≤ 300 ms                                  | 114 (109–148)    | 196           |                                                                            |
| Tap Sing → TV "Up next"                             | ≤ 250 ms                                  | 46               | 37            |                                                                            |
| Tap Sing → row on another phone's `/queue`          | ≤ 250 ms                                  | 134              | 119           | in the DOM at about 11 ms; about 120 ms is the row-hold animation          |
| Skip → next singer's strip                          | ≤ 100 ms                                  | 33               | –             |                                                                            |
| Skip → TV "Now singing" card visible                | ≤ 300 ms                                  | 137              | –             | fully opaque at 454 ms, the card's ruled 400 ms fade                       |
| Skip → "You're up" on the next phone                | ≤ 300 ms, and within 1.5 s of the TV card | 102 (91–215)     | –             | lands 34 ms before the TV card                                             |
| Skip → new song's audio running                     | ≤ 300 ms                                  | 43 (26–83)       | –             | `<audio>` element state only; WebAudio audibility is not proven            |
| Skip → lyrics back                                  | the ruled 2.5 s hold                      | 2608 (2551–2681) | –             | ceremony, not lag                                                          |
| Natural song end → next card                        | ≤ 300 ms after the last line              | **unmeasured**   |               | only skips were measured                                                   |
| Link lost → "Can't reach the party"                 | 3 s (ruled)                               | **unmeasured**   |               | the timer is in `core/src/lib/stores/room.ts`                              |
| Lyrics reel frame rate on a real TV                 | 60 fps, 0 dropped in a 10 s window        | **unmeasured**   |               | headless with no GPU drops 0–81 frames per 2.6 s, so it cannot answer this |
| Any row, on a real phone on Wi-Fi                   | the same targets                          | **unmeasured**   |               |                                                                            |

### Deliberate waits

The timers that sit on a budget moment today. Adding one, or lengthening one, needs the owner's ruling and a line
here. Paths are under `core/src/`.

| Wait                                    | Length                   | Where                                                    | Status                                                   |
| --------------------------------------- | ------------------------ | -------------------------------------------------------- | -------------------------------------------------------- |
| Handoff: skip → lyrics back             | 2.5 s (a host setting)   | `songIntroMs` in `lib/contract/core/settings.ts`         | ruled: the card tells the room whose turn it is          |
| "Now singing" card fade-in              | 400 ms (`--motion-slow`) | `lib/tv/TvTakeover.svelte`                               | ruled                                                    |
| TV attract phrase fade                  | 600 ms                   | `lib/tv/TvAttract.svelte`                                | ruled: a screen nobody is acting on                      |
| Try again acknowledgement               | 1.5 s hold               | `RETRY_ACK_MS` in `lib/components/ProcessingCard.svelte` | ruled: Try again answers at once with "Trying again…"    |
| Link lost → "Can't reach the party"     | 3 s                      | `lib/stores/room.ts`                                     | ruled                                                    |
| Pending indicator grace                 | 300 ms                   | `PENDING_GRACE_MS` in `lib/stores/room.ts`               | the pattern tenet 2 asks every indicator to follow       |
| Sing-tab and `/library` search debounce | 150 ms                   | `routes/+page.svelte`, `routes/library/+page.svelte`     | **not yet ruled**: about 75% of keystroke → result today |
