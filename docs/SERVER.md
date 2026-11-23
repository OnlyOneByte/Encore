# Server, jobs and contract

Constraints that hold across the server, the job pipeline, the shared contract and the Python
worker. The narrative model is in [`docs/ARCHITECTURE.md`](ARCHITECTURE.md); this file holds the
rules a change has to respect and what goes wrong when it does not.

## The shared contract

### Contract boundary

`src/lib/contract` is the code the Bun server, the SvelteKit client and the Python worker all agree on.
Membership is decided by one test: **would two copies of this have to be kept equal?** If yes it belongs
here, whatever else it is — `src/lib/contract/process/readiness.ts` and
`src/lib/contract/presentation/colors.ts` are derived view concerns and still live here, because a second
copy would drift.

- **Pure.** No I/O, no DB, no clock, no DOM, no `$app/*`, no `$env/*`. Every module must be importable from
  a Bun process and a browser bundle alike, which is why colour tokens and surface hexes are pinned
  literals with parity assertions rather than reads of `src/app.css`.
- **The barrel is the only public surface**, and every re-export in `src/lib/contract/index.ts` must be
  RELATIVE. A `$lib/contract/…` spelling routes the barrel back through the alias that resolves to it; a
  `$lib/…` spelling inverts the dependency and makes the contract depend on its consumers.
- **Dependencies run one way, downward.** A module the base layer references cannot live in the config
  layer: that is why `TvBackgroundStyle` sits in its own leaf, since `PlaybackState` and `RoomSettings`
  both reference it and holding it in the settings module closes a cycle.
- **Names are the wire.** Type names, field names, event and command names, capability tokens and registry
  ids are matched as literal strings by guards and parsed as JSON keys by the worker. Renaming one is a
  cross-language change, never a refactor.
- **Anything shared by both ends of a mutation must be the SAME function, not two agreeing ones.**
  `applyAndReseq` and `insertIndexFor` run on the phone to predict and on the server to commit; an insert
  rule that reads a clock, a random source, or anything outside its arguments makes the two diverge, which
  is the flicker the shared reducer exists to remove. State beyond the queue reaches a rule only through
  `Ordering`, whose fields are server-owned and broadcast.
- **Registries, not bare unions.** A flat id-keyed set goes through `makeRegistry`, so a stored value can
  be validated, one source renders every picker, and a new entry cannot ship without its accessor.
- **Untrusted input degrades per field; it is never rejected wholesale.** A normalizer takes the CURRENT
  value as its fallback base, so refusing one bad field cannot wipe an unrelated valid choice.

### Settings scopes

Two persistent layers plus one ephemeral lifetime. Both persistent layers are authoritative server state,
broadcast whole on `settings:changed` and included in `queue:sync`; a client never merges two events to
learn the effective state. The scope narrative is in `docs/ARCHITECTURE.md` §7.

| Scope      | Belongs to             | The test for membership                                           |
| ---------- | ---------------------- | ----------------------------------------------------------------- |
| **global** | the deployment + fleet | costs model weights, binaries, credentials or hardware capability |
| **room**   | one party              | two rooms on one core could genuinely want different values       |

The sentinels are where an innocent edit does damage:

- **`PROCESSES_UNCAPPED === 0` means NO CAP.** It inverts every ordinary comparison, so it must be tested
  BEFORE any `count >= cap`: reached with `0`, such a test refuses the first request of every party.
- **`MAX_PROCESSES_PER_SINGER_CEILING` bounds the number itself**, not a party, so a fat-fingered value
  cannot persist as a de-facto uncapped limit that still reads like a limit. Uncapped is spelled `0`.
  `normalizeMaxProcesses` therefore REJECTS a negative rather than clamping it to `0`, and floors rather
  than rounds.
- **`RoomSettings.maxQualityRank` is the one deliberate exception to fall-back-to-base**: an absent or
  invalid ceiling means NO ceiling, because falling back to the room's current cap makes the cap
  unremovable. It also lowers only — a room raising it would name an engine no worker advertises and the
  job would sit queued forever.
- **`joinOrigin: ''` means "not declared"** and is returned as `''`, so a caller can tell cleared from
  rejected; clearing it must fall through to the env var, not be refused.
- **`null` means INHERIT for every ephemeral field**, never zero. `keyShift` rests at `0`; `background`
  and `guideLevel` rest at `null`, so a room wanting a permanent faint guide does not lose it at each song
  boundary. Read them through `effectiveGuideLevel` / the room fallback, never raw.
- **`local` is never a legal `defaultFetcher`** — it describes one media's bytes, so storing it means
  "download nothing, ever". It degrades on read as well as write.
- **`songIntroMs` has no `0`**: the `songIntroEnabled` boolean owns "off", and a zero sentinel would
  destroy the dialled-in duration on toggle.
- **`lyricsBall` and `lyricsHighlight` must be read through `resolveLyricsPresentation`** and never off
  the room. It clamps downward against TWO independent bounds — the fleet's `syncMode` and the playing
  song's own `timing` — and answering the per-song question from the global alone paints the word
  treatment over an empty `words[]`, so the current line loses its accent. Unknown song timing does NOT
  clamp. The reel's size, font, case and row counts are read straight off the room, because routing them
  through the resolver would dilute what its `clamped` flag means.

### Colour tiers

Two OKLCH tiers, both generated by `hueToHex` in `src/lib/contract/presentation/colors.ts`. The tier table
and the accent-guard ramp are in `docs/ARCHITECTURE.md` §4; these are the rules.

- **The tier follows what the colour is painted ON, not who chose it.** The singer tier is a small fill on
  a dark card and is bound at WCAG's 3:1 non-text minimum. The stage tier is the whole screen behind
  word-timed lyrics, so it is generated far darker and less saturated.
- **No token from either tier may carry or back text.** `SINGER_COLORS`, a `PaletteStop.fill`, a stage
  colour and a visualizer palette entry are fills only. Text on top of a stop uses that stop's `on_fill`
  or `accent_ink`; those two are the only text-bearing values in the palette, and they exist because a
  fill cannot be assumed to be its own AA text colour.
- **Guests choose a HUE. Lightness and chroma are not theirs**, which is what guarantees every stop is
  visible on the app's surfaces and distinguishable from its neighbours.
- **The stage tier governs only colours nobody picked by hand** — the `singer` glow and the visualizer
  palettes. A room's own `solid` colour is stored and rendered verbatim and may be white, because the
  lyric reel defends its own legibility with a text stroke rather than the field being restricted.
- **Validate legibility, never list membership.** `isLegibleSingerColor` tests a parseable hex against both
  surfaces; an allowlist silently rewrites every non-preset hue. The presets deliberately sit outside the
  wheel's lightness band, so a band check would reject all of them and every singer who ever joined.
- **`normalizeStageColor` has no legibility gate and `normalizeSingerColor` does.** An invisible identity
  dot is unrecoverable, because a guest cannot see their own dot on someone else's TV; a room is looking
  at its own stage. `lyricHighlightColor` returns `null` rather than falling back to a preset, because a
  fallback paints one guest's words in another guest's identity colour.
- **Canonical 6-digit lowercase hex, everywhere, is load-bearing.** These values are interpolated into
  `style` attributes and have alpha digits concatenated onto them; a 3-digit hex silently drops the result.
- **`SURFACES`, `ACCENT2` and `DEFAULT_STAGE_COLOR` are pinned literal copies** held equal to their CSS
  tokens (and to `stageHueToHex(240)`) by parity assertions, because a browser bundle cannot read
  `src/app.css`. `DEFAULT_STAGE_COLOR` is additionally a literal because a SQLite column default and a
  migration backfill need those exact bytes and SQL cannot run an OKLCH conversion.
- **Reduce chroma until in gamut; bound the loop by chroma reaching zero, never by an iteration count.** A
  clip does not desaturate a hue, it SHIFTS it, collapsing two adjacent wheel stops onto one colour.
- **Recover a hue angle with `hueOfColor` and not `nearestSingerHue`.** The latter compares OKLab `(a, b)`
  against candidates generated at the wheel tier, so a stage-tier colour snaps to the wrong stop for most
  legal hues. `atan2` on the same axes is scale-free and reads both tiers on the same terms.

The 48-stop ring in `src/lib/contract/presentation/player-palette.ts` adds three rules:

- **It must read the `uniform` variant.** `chromatic` spans a wide lightness range because it is for the TV,
  where a stop is a whole field; `uniform` pins every stop in the band `hueToHex` emits at `SINGER_L`, which
  is what makes any two stops equally visible as a small dot. A `chromatic` stop can read as a field and fail
  as a dot.
- **A stop must resolve EXACT first, then nearest by hue angle.** The exact path is what makes a stop
  round-trip: without it the knob drifts a stop every time the component re-derives its position.
- **`PALETTE_RING_FROM_DEG` is read by both the gradient and the knob.** A `conic-gradient` measures from 12
  o'clock and `from` rotates the PAINT, while a `rotate()`d knob knows nothing about that rotation — so a knob
  placed at a stop's gradient angle points 90° away from the colour it claims. Both must read the one constant.
- **The ring paints HARD sectors, never an interpolated band.** A blended band shows colours the ring cannot
  return, so a guest aims at one and gets its neighbour.

### Queue ordering and rotation

The queue is ONE stored ordered list and that list is the truth: `rotationSeq` is each entry's durable
position, mutated in place and renumbered contiguously, and nothing re-derives order from entry fields.
Rotation lives in `src/lib/contract/queue/rotation.ts`, the policies in
`src/lib/contract/queue/queue-order.ts`. Narrative: `docs/ARCHITECTURE.md` §4.

- **An ordering algorithm is an INSERT-POSITION rule, not a sort.** It answers "at what index does this
  newly-added song go?" and is consulted ONCE, at insert, in `insertEntry` and nowhere else. After that it has
  no authority over the song, which is what makes a later drag durable by construction — there is no
  re-derivation for it to fight.
- **Every insert rule must be PURE, TOTAL and DETERMINISTIC.** The same rule runs on the phone to predict and
  on the server to commit, and nothing reconciles them but the fact that they agree. A rule that reads a
  clock, a local random source, or anything outside its arguments makes the predicted index diverge from the
  server's — the flicker the shared reducer exists to prevent. `insertIndexFor` clamps an out-of-range result
  so the rule stays total.
- **A rule gets state beyond the queue ONLY through `Ordering`**, whose fields are server-owned and
  broadcast. `lastSungAt` absent means never sung, which is NOT `0`, and is why it is a map rather than a
  field; a locally derived map or a locally rolled `shuffleSeed` orders the queue differently on every device.
  `least-recently-sung` ranks an unsung singer at `-Infinity`, so a room whose clock reads 0 behaves like one
  at a real timestamp.
- **`Singer.lastSungAt` is stamped at song START, not end**, so a singer's remaining picks drop behind
  everyone else's the moment their turn begins. It lives on the singer and not in `plays`, because that table
  carries no singer id: this records THAT someone sang and when, never what, which is what makes it safe to
  broadcast on the public roster.
- **`assignSeqs` runs NO policy.** The list leaves in the order it arrived, so calling it on an unchanged
  queue is a no-op and switching the room's algorithm re-sorts nothing already queued.
- **The queued rows are permuted among the slots they already occupy.** A playing or terminal entry keeps its
  slot and never occupies a queued index, so an insert can never displace the song on stage.
- **`move` counts the singer's OWN queued picks; `move-to-index` counts every queued entry.** `move` permutes
  one singer's songs among slots that singer already holds, so it can never jump another singer — a
  cross-singer move must be `move-to-index`, gated on `queue:reorder-any`. Counting a playing entry in
  either index space makes every index one short.
- **A song the TV cannot play is not sung.** `tv:telemetry` with `status: 'failed'` advances the room exactly
  as `ended` does, under the same entryId rule, but the server-owned `play-failed` op puts the entry back to
  `queued` with `playFailed` in the slot it already held. `nextPlayable` and `upNextAfter` skip it — the same
  held-slot rule as a song still processing — and the phone's `nextPlayableEntryId` mirrors that, so no screen
  crowns a turn the TV will pass over. Nothing moves it, which is the whole of "a failed song keeps its spot". The next
  song starts PAUSED behind the TV's Skipped notice; the TV's `resume` telemetry, naming that song, starts it, and a
  play/pause/skip/restart from a phone outranks the hold (key, guide and background do not touch it). A TV that loses
  the `resume` frame (a reload, a socket drop) never sends it, so the server starts the held turn itself after
  `HOLD_FALLBACK_MS` (the shared `SKIP_NOTICE_MS` plus 2 s), and only while THE TV is connected (`tvConnected`: the
  seat has a live socket, `TvSeats.hasLiveHolder`). A copy does not count, since its frames are dropped and it could
  never report that song failing. With no seated TV the room stays paused at 0 and no phone is told "You're up"; the
  seat's next hello (or a copy's `tv:claim`) starts it, from 0, with its own card, so the TV and every phone start
  together. A copy PROMOTED when the seat's grace runs out does not start it; a play from a phone does. The timer only acts on the
  song still held, so a lifted hold leaves it nothing to do. **A TV that comes back INSIDE the hold shows its "Now
  singing" card silent for up to ~2 s:** only the TV that raised the notice sends `resume`, so the returning one waits
  out the fallback, by design. Each timer is keyed by a hold NUMBER, not the entry: Try again lets one entry be held
  twice inside one fallback window, and the first timer must not start the second hold early.
- **The singer's way back from a held turn is owner-only.** `retry-play` ("Try again") is one of the owner ops in
  `on-deck-ops.ts`, with no `-any` capability: another singer, the TV and a socket with no session are refused. It
  clears `playFailed` and moves nothing, so the turn plays straight after the current song, ahead of whoever is On
  deck (who gets #14's "going first" line), or at once in an idle room, through `reconcileOnReady`. `play-failed`
  counts `playFailures`; at `MAX_PLAY_FAILURES` (2) the hub refuses `retry-play` and the phone offers only Pick
  another. Its `replace-media` lifts the hold and starts the count again for a DIFFERENT song; the same song keeps
  its count and is refused past the limit, like a Try again. On a HELD turn `replace-media` is owner-only too: its
  `remove-any` gate applies only to a turn that is not held. Those two ops are the only client ops that clear
  `playFailed`. Both fields are server-owned: a re-sent `add` keeps the server's values.
- **`DEFAULT_QUEUE_ORDER` is what an unconfigured room does**, so changing it re-orders every existing room
  that never chose. An unknown or de-whitelisted id degrades to it rather than throwing.

### Lyrics candidates and grading

`src/lib/contract/lyrics/lyrics.ts` is the authority and `worker/encore_worker/domain/lyrics/` mirrors it; the
shared-corpus parity guard holds the two equal. The acquisition model is `docs/ARCHITECTURE.md` §8.

- **Text quality and timing fidelity are INDEPENDENT axes**, which is why a song keeps a SET of candidates
  rather than one doc. Keeping the losers buys an upgrade path with no recompute: a late-arriving
  authoritative text is re-aligned from retained audio, with no re-download and no re-separation.
- **NEVER-REGRESS is a property of keeping everything, not of a check.** Because nothing is removed, adding a
  candidate can only improve or preserve what `pickBestLyrics` returns, so a line-level source arriving late
  cannot displace existing word timings the way a "latest wins" write would.
- **The worker's verdict decides WITHIN its report; the ranking decides ACROSS reports.** An align completion
  reports every document it wrote (retention must name them all) and marks each one its ladder did not publish
  `selectable: false`: retried, moved past, or — a job that found no lyrics — all of them. `lyricsRank` gives such
  an attempt 0, so it is kept for retention and a person's re-pick but never auto-selected; ranked as a peer, it
  was shown over the document the worker chose (review M3) — replayed over the alignment bench's run_align
  ladders, in 319 of 768 song-modes, 236 of them a wrong text the worker had declined. Absent means selectable,
  so stored rows rank as before. When nothing is showable and the pointer names a file a report withdrew (a
  re-run rewrote it with a rejected attempt), `setMediaLyrics` clears the pointer instead of showing the reject.
  A report also WITHDRAWS an earlier job's candidate for words its gate refused: a refused attempt writes
  nothing, so the worker names each stored document of those words (same label, same text) `selectable: false`,
  and the merge by ref replaces the stored entry — without it, a re-align that refused a text left the earlier
  job's document of it ranked, and shown, over what the re-align published (review W1 r2).
- **`textConfidence` is the WORDS' standing, `timingConfidence` their placement.** The worker derives the first
  from the text's tier — a claim (a provider sheet, an authored caption track, a paste) is `high`; a transcript
  and YouTube's machine track are `low` — and sends its timing grade only as the second. One field carrying both
  made a well-timed machine caption authoritative and ranked every line-synced sheet as a guess.
  **A `low` timing grade now counts as LINE timing in `lyricsRank`** (W6, worker review §3.7): the grade is an
  aggregate of the worker's per-LINE verdicts, so a `low` word document is one whose word positions nobody
  stands behind, and 4 (authoritative + line) outranks 3 for the same reason it always did — what you cannot
  sing to is a failure. It is the same judgement the TV makes row by row, where a `low` LINE renders without
  the word wipe (`lib/tv/lyrics.ts` `wipesWords`); ranking a document as word-timed while rendering it as
  line-timed was the contradiction this closes. **The transition the current worker reaches is 3 → 2, not
  5 → 4** (W6 review r1-spec-17): it writes a document-level `low` in exactly one case — a pin a wrong-text
  gate would have refused — and sends `vouched: false` with it, so both legs move together onto the
  unauthoritative rungs. 5 → 4 is reachable only for a document STORED BEFORE `vouched` existed, which is why
  the rule reads `timingConfidence` on its own rather than hiding inside `isAuthoritativeText`. A person's
  re-pick (a job carrying `pinnedText` / `pinnedRef`) is `high` whatever its tier: a human chose those words, as
  the old worker had it. So a re-picked machine track reads as "Captions", while a re-picked transcript is
  still no claim, because core never counts `asr` words as one.
- **`vouched: false` is a THIRD axis: a wrong-text gate read these words and did not vouch for them.** The
  worker's lexical doubt band, a pin whose lift its gate would have refused, and a text no such gate could
  read (`domain/lyrics/lexical.py`, W3 review r1–r2). `isAuthoritativeText` reads it, so such a document ranks
  under one a gate passed — the timing grade could not carry that, because the doubt band's grade is `medium`
  and `lyricsRank` reads only a `low` one (and before W6 read none at all, so a doubted word document tied a
  fully vouched one at the top rank). It is a
  field of its own because `textConfidence` already carries a second claim: `lyricsSourceLabel` reads
  `captions` + `low` as "Auto captions", so sending the doubt there showed an uploader's hand-authored caption
  track as machine-generated — a false statement about its provenance rather than about its words. SENT ONLY
  WHEN FALSE; absent (every stored row, every earlier worker, a withdrawn document whose gate never ran here)
  reads as vouched, since nothing can infer it, while a value core cannot read fails safe to `false`. Both a
  worker's
  report and a stored row are READ through `parseLyricsCandidates` (fail-safe on values it cannot read), never
  cast; the cross-language fixture `tests/unit/contract/lyrics/worker-align-contract.json` is written by the
  worker and holds the two sides to one reading.
- **A human override is layered ABOVE the ranking, never inside it.** `resolveLyricsRef` is the one place
  override-then-rank is defined, and both rank-derivation sites must route through it. An override naming a
  ref no longer in the set is IGNORED, so a stale pointer falls back to the ranking instead of blanking the
  overlay. `lyricsOverrideText` travels with its ref and is CLEARED when a different candidate is picked, or
  it re-times abandoned words over the human's choice.
- **TWO AXES, and only one may be thresholded.** `agreement` is a RANKING score, `coverage` is BASELINE
  COVERAGE and is the only axis the absolute wrong-song judgement may threshold. Coverage is immune to the
  size asymmetry between a full text and a partial transcript; the ranking score is not, so thresholding it
  convicts a correct candidate whose baseline heard only part of the song — which is the NORMAL case, since
  automatic captions suppress sung vocals.
- **The directional split is the point, so ARGUMENT ORDER is load-bearing.** Averaging the two directions into
  one symmetric number destroys the fingerprint of "right song, wrong version" — near-complete coverage of
  the audible words while much of the candidate is not audible at all. Swapping the arguments swaps coverage
  and fidelity.
- **ABSTENTION, not zero, is what makes a weak baseline safe.** Below `MIN_TOKENS_TO_COMPARE` distinct tokens
  the comparison returns `null`. An instrumental transcribes to almost nothing, and scoring that as total
  disagreement condemns a correct lookup: "I cannot tell" and "these differ" must never be the same answer.
- **Ranking is threshold-free and both halves run.** `SEQUENCE_WEIGHT` is EQUAL with the count-aware term
  because any other split is a coefficient nobody has measured, so it steers a comparison and can never on
  its own accept or reject anything. `SUSPECT_COVERAGE` answers the different, absolute question.
  `SUSPECT_COVERAGE` is a SYNTHETIC-corpus calibration — re-derive it once a real corpus exists, and rename
  the constant rather than re-point this name at another metric.
- **Tier 1 needs a dedicated bottom rung.** Demoting a suspect text's `textConfidence` alone drops it only to
  the rank of the baseline that convicted it, and the tie-break then PREFERS it, because it carries a numeric
  agreement where a baseline carries none.
- **Both languages must produce bit-identical doubles**, so the rank-score expression and its operand order
  must match, every intermediate staying an integer count. The token fold (NFKC, punctuation strip) must match
  too. The parity corpus's expectations are hand-computed integer `[numerator, denominator]` pairs, never
  output of the code under test, and every token in it must be a NAMED const — the Python mirror resolves a
  template literal by joining its `${NAME}` interpolations and silently drops bare text.
- **An overshoot past the end of the audio DEMOTES comparatively; it is not a hard cutoff**, and it is a
  FRACTION of duration rather than raw seconds, or it is lenient on a clip and harsh on a long track.
- **Automatic captions are a baseline and never a candidate, and a machine-translated caption track is
  refused outright** — it is fluent, long enough to clear the compare floor, and about the right song in the
  wrong language, so it would not abstain, it would vote confidently against every correct candidate.
- **Baseline preference order is only for choosing a fallback to SHOW**, never to weight grading, where every
  speaking baseline gets one equal vote.

### Registries and the quality ladder

Every flat id-keyed set goes through `makeRegistry`; the two-level separator registry in
`src/lib/contract/lyrics/separators.ts` is deliberately excluded, as is the computed colour palette.

- **The whitelist is a SAFETY boundary, not curation.** A phone can only pick from the fixed set, so a tap
  can never trigger an arbitrary multi-hundred-MB checkpoint download onto the shared box.
- **A model id is a stable TOKEN, never a checkpoint filename**, so upstream can re-host or rename without
  touching stored jobs or settings.
- **`rank` is REQUIRED on every model and lives on the model**, not in a parallel table. That makes "a
  whitelisted model silently ranks 0 and drops off the ladder" a compile error. Ranks are globally ordered
  ACROSS engines, and `qualityRank` returns 0 only for a pairing absent from the registry — a rank-0 pairing
  can never displace a known-good artifact, which is what makes de-whitelisting safe.
- **`isQualityUpgrade` is STRICT.** A missing current is an upgrade; equal or lower rank is not, so a
  re-process at the same quality is a no-op and a worse engine can never replace a better one.
- **`liveSelectable: false` means upgrade-only** and must never be offered as the live default.
- **Cost numbers are measurements on ONE box.** `rtFactor` is a ratio for UI estimation and NEVER a gate;
  `provenance: 'estimated'` must never be cited as evidence. Two traps: `cpuPrecision` REVERSES per
  checkpoint, so there is no global precision switch; and parameter count does not predict cost, because
  window geometry dominates, so nothing may be inferred from checkpoint size. `overlap` is an integer window
  count and is ABSENT where the engine's overlap is a fraction instead — one field name for two meanings is
  how a `4` gets passed where `0.25` belongs.
- **A checkpoint's weights are not covered by the project's package-licence clearance.** Check the model
  card before adding one.
- **An unverified ASR token is a process that fails at model load**, which is what the whitelist prevents;
  `params` is a published fact about a checkpoint and not a measured cost, so do not add an rtFactor there
  until someone has timed it.
- **Presentation registries carry the constraint they are checked against.** `needsWords` and `granularity`
  are load-bearing FIELDS the resolver reads, not documentation — adding a style must stay a registry entry
  rather than an edit to the clamp. A font stack must be LOCALLY available (no webfont, no CDN, since the box
  may have no route out) and must end in a generic family; letter case is `text-transform` only, so the DOM
  text, the per-word spans and the marker stay untouched.
- **The reel's size is a PERCENT of the computed scale, never an absolute.** A stored pixel size discards the
  viewport term and renders wrong the moment the TV's resolution changes. Its MIN equals the neutral point,
  because the neutral render IS the legibility floor after the `LYRICS_SCALE_BASE` fold, and every row-count
  and lead bound exists for the same reason. A negative lead clamps to 0: running the highlight BEHIND the
  audio reads as the overlay being broken.

### Membership and presence

`src/lib/contract/queue/membership.ts` is a pure three-valued policy over transport facts — `here` (live
socket), `away` (no socket, still counted, shown greyed), `gone` (grace expired, name back in the pool).

- **Who is IN THE ROOM is not who holds a socket.** Conflating them drops a singer seconds after their phone
  locks, while they are standing there holding a microphone.
- **The grace clock does NOT start when the socket drops.** It starts once the singer holds no pending songs,
  because a queued song is a stake in the room — and a self-liquidating one, since songs play or get skipped,
  so the clock always eventually runs.
- **A grace of 0 means "no grace once your songs are done"**, never "vanish the instant your socket drops".
  Pending songs hold a singer at every setting, which is what makes the clock meaningful at all.
- **Never seen means not a member.** That is what keeps a restarted server's roster empty until phones
  reconnect rather than inventing members it cannot vouch for.
- **The policy map is not the published roster.** `server.ts` holds a module-level `membership` CACHE, and
  that — not `presence` — is what the per-socket replies it builds carry: the `hello` reply's `queue:sync`,
  via its per-frame `listOnline`/`listAway`, plus the `singer:presence` broadcast. (The one `queue:sync`
  built elsewhere, `app.ts`'s `onMediaReady` broadcast, reads `presence.online()` live and omits `away`.) It
  is re-derived on socket edges, on a `queue:command` and on the 20s sweep, so anything that changes who is
  in the room OUTSIDE those must say so by calling `app.refreshMembership?.()`. An explicit leave is the
  live example: `presence.forget` deletes their record, but the leaver's own socket closing cannot refresh the
  cache (`disconnect` is a no-op for a record already deleted), so without the call the next `hello` — a TV
  reload, or its 15s heartbeat — re-advertises someone who went home and the television names them as in
  the room.

### Song profile and readiness

- **`songProfile` is ALWAYS written once the stems job completes, with every inner field nullable.** That
  shape is what lets the `stems` gate tell "not analysed yet" (record ABSENT → still processing) from
  "analysed, found nothing" (record PRESENT, nulls inside → FINISHED). Keying the gate on range DATA
  instead leaves a song whose vocal stem came back as digital silence permanently unsingable AND unable to
  re-process, because the re-process check reads `hasInstrumental` rather than the gate.
- **The gate does not require the profile record, deliberately.** The worker writes it beside the ready
  mark, so `stemStatus === 'ready'` already proves it ran, while requiring it makes every song processed
  before profiles existed unsingable forever. A wire-shape regression is caught loudly by the parity test,
  not silently by the gate.
- **"Done" means the step RAN, never that it produced output.** A genuine instrumental finishes with no
  `lyricsRef` and is a finished song. Media predating a gate carry no status for it, so an existing
  artifact counts as done and an upgrade cannot make a library unsingable.
- **Two questions, two names, and they must not merge.** `playbackRef` / `hasInstrumental` answers "what
  file do I load" (the TV player, the re-process check); `readyToSing` answers "is this song finished"
  (rotation, the library, the Ready group). Adding a step to the first makes a finished song re-process
  from scratch.
- **`isPlayable` requires the status AND the artifact key.** They are written by separate steps, and a
  status running ahead of its ref hands the player an empty source.
- **Readiness is gate-driven, never a single status.** One status only ever sees the first step, so a song
  mid-align matches neither ready nor queued and falls through to `unacquired`, offering a Sing button on
  an already-separated song. `failed` is deliberately not a `CatalogReadiness` member: a dead process
  settles back to un-processed, so the catalog's honest answer is `unacquired` and failure is a live event.
- **A range is only meaningful as a complete, ordered set**, so a partial or inverted one is discarded
  whole. **`loudnessLufs: null` means NOT NORMALIZABLE** — leave the level alone and never substitute a
  default, since 0 LUFS reads as a deafening master and attenuates the song into inaudibility. Loudness is
  validated against a measurable window rather than finiteness, because an out-of-window number is a bad
  reading and trusting one attenuates by a gain derived from noise.
- **`rangeOctaves` must span the same pair `rangeLabel` prints.** Both are rendered adjacent as one value,
  so measuring one over the percentiles and the other over the extremes shows a reader two numbers they
  cannot reconcile.
- **Adding a processing step is one entry in `GATES`** in `src/lib/contract/queue/gates.ts`, including its
  `MEDIA_STAGES` stop. A separate gate-id → stage map means registering a new gate in two places, and the
  second is the one nobody thinks to look for.

## Server, realtime and persistence

### Authority and the hub

One Bun process serves both SvelteKit and the WS hub, so room state lives in memory, is authoritative, and
broadcasts never wait on a DB read. The reconciliation model is in `docs/ARCHITECTURE.md` §3.

- **There is exactly ONE `EncoreApp`, held on `globalThis` and not in a module-level binding.** SvelteKit's
  production bundle is a separate module graph from `server.ts`'s, so a module-level instance split-brains
  the state — and in dev gives the two graphs separate in-memory databases. `server.ts` injects the real
  `Bun.serve` publish sink into that one app once, at boot, never per connection.
- **The server is the only writer of server-owned fields.** `rotationSeq` is re-stamped on apply and
  `addedAt` is server-owned; a client-supplied value for either is ignored, not trusted.
- **`reconcileOnReady` is the single decision point after every queue mutation** — auto-start on
  idle-plus-queued, self-heal a dangling `currentEntryId`, re-derive `upNext` — and its tail emits
  now-playing exactly once per command. A caller must not emit one as well.
- **`roomTopic(roomId)` is the tenancy boundary for broadcasts.** Every event for a room publishes to that
  topic and no other, and the id comes from the internal `rooms.id`. Publishing anywhere else is how one
  room's event reaches another room's clients.
- **Every command is gated in ONE place**, `validateCommand` in `src/lib/server/realtime/hub.ts`, against
  `can()` in `src/lib/server/capabilities.ts`. There is exactly one auth axis: anonymous versus a singer
  holding a session cookie. `can()` grants EVERY capability to any singer with a non-empty id and none to
  anyone else — including `player:control`, `settings:write-global`, `settings:write-room`,
  `queue:reorder-any` and `queue:remove-any`. A capability check is therefore a LIVENESS check and not an
  authorization one; treat any new capability as open to every phone on the LAN.
- **Ownership is the only finer-grained gate that exists.** A singer may remove their own entry
  unconditionally; touching somebody else's needs `queue:reorder-any` / `queue:remove-any`, which every
  joined singer also has. `move` can never cross singers by construction — it permutes one singer's picks
  among slots that singer already holds — so a cross-singer move must be `move-to-index`.
- **On deck is held (proposal 14).** While its On deck card shows — someone else sings and it plays next — the
  room's next playable entry keeps its turn. Which entry that is has ONE rule, `heldEntryId`
  (contract/queue/on-deck-hold.ts), read by the server, the phone's pinned row and both sides' add placement:
  - a `move` or `move-to-index` by anyone but ITS owner that would move it, or put a row in front of it, is
    refused with `on deck is held: <id>` — the moved row's owner included (last check in `entryOpRefusal`);
  - an `add` lands no higher than just after it under every queue order: `insertEntry` clamps the policy's index
    through `Ordering.heldId`, which the hub supplies and the phone predicts from the same rule;
  - its owner keeps every move. Not held in an idle room or for the current singer's own back-to-back song (no card
    shows). It STAYS while its singer's phone is locked or away (the owner's ruling, `HOLD_LIFTS_WHILE_AWAY = false`)
    and cannot stall the room: it ends when that turn starts (and can be skipped then), on its owner's Not yet, on a
    host remove (`remove` is never held), and when they leave (`doLeave` removes their queued songs).
  Changing the room's queue order mid-song re-places only future adds, never existing rows, so it cannot reorder
  past the hold; a later "re-sort on change" would have to respect it.
- **`can()` gates only CROSS-ACTOR operations.** Removing or reordering your own entry needs no capability;
  `queue:remove-any` / `queue:reorder-any` gate acting on someone else's. Routing a singer's own move
  through a capability check blocks their own song the moment `can()` starts enforcing a host role.
- **The actor identity is resolved from the session cookie at WS upgrade and is never client-supplied.** An
  `add` op's `singerId` must MATCH it, or any socket could queue songs as anybody.
- **`status` is never accepted from the wire.** Only `src/lib/server/realtime/player.ts` applies a status
  change directly. Admitting one from a client lets it forge a second `playing` entry, write an
  off-vocabulary string, or retire a song whose process is still running.
- **A malformed frame is IGNORED, never fatal, and must fail validation BEFORE any property is
  dereferenced** — one bad message otherwise crashes the process. An unknown op is REJECTED rather than
  falling through a switch as `undefined`, which a caller reads as valid. A cosmetic control (`background`,
  `guide`) whitelists its value server-side and drops an unrecognised one rather than tearing down the
  socket; `null` is accepted explicitly and means "hand the song back to the room default".
- **The op ledger must only record on a path that actually applies the op.** Use the non-recording peek on
  a validation-failure path: recording an invalid, never-applied op means its resend is falsely re-acked
  instead of rejected.
- **Presence comes from the socket, never from the `singers` table**, which is persistent and append-only.
  Presence and settings broadcasts are FULL SNAPSHOTS, because an idempotent snapshot cannot drift the way
  an add/remove stream can after a dropped frame.
- **Every ephemeral `PlaybackState` field is reset through the single `EPHEMERAL_RESET` object** in
  `src/lib/server/realtime/player.ts`, spread at all of its reset sites — song advance, play-from-idle and
  `reconcileOnReady`'s song-start branch. Nothing rebuilds that object per song, so a field reset by hand at
  some sites and missed at one leaks the previous singer's choice into the next turn and the type checker
  cannot see it. Adding a field means one edit to that object; the two nullable fields reset to `null`
  (INHERIT), never to a concrete value. A song START spreads `songStart(entry)`, which is that reset with the
  entry's on-deck preset (`QueueEntry.keyShift` / `guideLevel`, set by the owner-only `set-entry-prefs` op) in
  place of the key and guide; an entry with no preset starts exactly reset.
- **`state.reorder()` returns null when the order is unchanged** and then touches nothing, which is what
  makes it safe to call from the playback path as well as from a settings write.
- **The store SELF-HEALS a persisted dangling `currentEntryId`**; there is deliberately no boot resync and
  no boot reconcile. Playback advances only from a `queue:command`, from `onMediaReady`, or from a manual
  play — a boot path that started a song would resume a party nobody is in.
- **`setPlayback` / `setPosition` drop `undefined` and non-finite values before writing.** Either persists
  as SQL `NULL` against a `NOT NULL` column and crashes the process asynchronously from inside the flush
  timer, far from the call that caused it.
- **Sub-second position precision survives in memory and on the wire, and is floored only at the
  persistence boundary.** Flooring earlier makes the first second of every song broadcast an exact
  `positionSec: 0`, which the guide's sync logic reads as an unambiguous rewind.

**Boot order is load-bearing, and this is it:** open the DB and run migrations → migrate the storage layout
(wrapped, never fatal) → load settings BEFORE constructing the authoritative state, because the state reads
ordering from settings live → mint or adopt the active room → hydrate the runtime media catalog before
anything reads it → reconcile stranded readiness gates SYNCHRONOUSLY, so a stranded song is never observable
as stranded → fire the detached boot-maintenance passes, each isolated so one failure cannot skip the rest →
recover orphaned `assigned`/`running` jobs. Only then does `server.ts` start the reaper's tick loop.

**Graceful shutdown** on `SIGTERM`/`SIGINT` flushes the authoritative state, stops the reaper, then stops
the server — and exits NON-ZERO on a failed flush, so a supervisor is never told a clean stop happened when
queue and playback state was actually lost.

### Sessions and cookies

There is no operator identity and none is planned in this shape; see `docs/ARCHITECTURE.md` §10 for what
that leaves open.

- **One cookie: `encore_singer`.** It is written by exactly one live writer, `cookies.set` in
  `src/routes/api/join/+server.ts`, and cleared by `cookies.delete` in
  `src/routes/api/leave/+server.ts` with a MATCHING `path`, or the delete does not apply.
- **A cookie is a browser, not a tab, and a Leave ends it on the server.** The tabs of one phone share the
  cookie, so they are one singer. `POST /api/leave` replaces the singer's token (`endSession`), so no copy of
  the cookie resolves again, and releases every socket opened with it (`singer-sockets.ts`): each stops acting
  as them at once and every phone socket is closed, so its tab reconnects and asks `/api/me`. A socket's
  singer is still fixed at upgrade, and re-checked at open in case a Leave landed in between. On the phone,
  a tab that joins or leaves posts on the `encore-session` BroadcastChannel; every other tab, and any tab
  coming back to the front, asks `/api/me` again. A 401 is the join screen; a different singer reloads the
  tab as that singer.
- **Its five attributes are fixed:** `path: '/'`, `httpOnly: true`, `sameSite: 'lax'`, a 30-day `maxAge`,
  and `secure` derived from the real forwarded scheme via `publicOriginIsHttps`. `secure` must NOT come from
  `url.protocol`: the node adapter reports https for every request, which marks the cookie Secure on a
  plain-HTTP LAN party and the phone discards it.
- **A hand-rolled `Set-Cookie` serializer is forbidden.** SvelteKit owns serialization; a second writer is
  a place attributes can be hardened without the browser ever seeing it.
- **There is no room cookie.** A room is a tenancy boundary, so a room id resolves through the singer's row
  in `src/lib/server/realtime/room-scope.ts` and never as a client claim. Never reintroduce one, and never
  write prose claiming the room-scoping chain reads one.
- **`singers.session_token` carries a unique index.** Identity is derived from the cookie's token, never
  from anything the client asserts about who it is.
- **A phone learns its room id from the `/api/join` RESPONSE BODY**, never from a cookie.
- **A TV carries no singer, and its one cookie names a screen, not a room.** It binds its room from the
  join CODE on the WS URL — the same code the QR encodes — resolved through the rooms table, and falls back
  to the active room for an absent or unknown code. That fallback is a deliberate spectator-safe default,
  not "go dark"; mutations stay gated by the per-command checks however a socket resolved its room.
- **`encore_tv` names a screen for the TV seat** (see [The TV seat](#the-tv-seat)). `GET /tv` writes it with
  the same five attributes as `encore_singer`, re-set on every load, from `mintSessionToken()`. It is an
  identity, not a password: the trusted-LAN line in the README is unchanged.
- **A socket falls into exactly three room classes**, and each gate reads the class rather than re-deriving
  it: IN-ROOM (full access), FOREIGN (refused, and subscribed only to its own room's topic), SPECTATOR (no
  room at all — a legitimate viewer, still gated per command on mutation). An unscoped viewer of the served
  room is not a cross-room leak, and treating it as one breaks the TV.
- **HTTP statuses are part of the contract, because the phone branches on them.** `429` means specifically
  the per-singer concurrent-process cap, so a limit is distinguishable from a generic refusal; `409` is a
  conflict the caller can resolve (a taken name, a song that is not processable); `404` is an unknown media
  or room; `400` is malformed input. Substituting one for another changes what the phone tells a guest.
- **Route auth posture is pinned per METHOD, and the registry is CLOSED** — a new route method with no
  entry fails. `POST /api/join` is necessarily ungated, since it is how a session is acquired. `GET` on
  `/api/library`, `/api/search`, `/api/stats`, `/api/thumb`, `/api/metrics`, `/api/room-preview`,
  `/api/audit/[mediaId]` and `/api/settings` are ungated; `PUT /api/settings` and `PUT /api/settings/room`
  are capability-gated; everything that mutates a caller's own record or queues work is session-gated,
  including `POST /api/delete-media`. `/api/thumb` is bounded by an https-only host allowlist rather than by
  a session, which is the SSRF boundary and not a convenience.
- **`plays` carries no singer column, structurally.** That is what makes the public stats endpoints
  aggregate-only by construction rather than by a filter, so no per-singer figure can be served from them
  even by mistake.

### The TV seat

One `/tv` per room is THE TV: only its socket's `tv:telemetry` can end the song or move the playhead. Any
other `/tv` (a guest reading along on a phone, a forgotten laptop tab, a cookieless `/ws?role=tv`) is a
copy. `src/lib/server/rooms/tv-seat.ts` owns the rules; `server.ts` only feeds it socket edges.

| What happens | The seat |
| --- | --- |
| A screen with an `encore_tv` cookie connects to a free seat | It takes it |
| The holder reloads, or its wifi blips | Same cookie, so it is the holder again; the newest socket of that screen is the live one |
| The core restarts | `rooms.tv_seat` kept the holder, so it gets the seat back when it reconnects, and a copy that reconnects first is not promoted for 60 s (`TV_SEAT_SLOW_BOOT_MS`): a TV boots slower than a phone tab |
| The holder is gone for 15 s (`TV_SEAT_GRACE_MS`), e.g. its cookie was cleared | The newest copy with a cookie takes the seat; with none, it goes free. Never while the holder's cookie connected within the last 60 s, so a TV that flaps while it boots keeps its seat |
| A copy sends `tv:claim` ("Make this the TV") | It takes the seat at once, and the old holder becomes a copy |
| A socket with no cookie | Never holds the seat and cannot claim it |

Each TV socket hears `tv:seat { mine, tvOnline }` on connect and whenever either changes. `tvOnline` is
whether the seat's screen has a live socket, so while the TV is gone a copy says "The TV is reconnecting..."
instead of "Another screen is the TV". It is one boolean and changes nothing about who may hold or claim the
seat. `rooms.tv_seat` stores a SHA-256 of the cookie, never the cookie itself.

**The seat is an identity, not an auth gate.** Only the cookie's shape is checked, so a planted or known
`encore_tv` value (cookies are not port-scoped) counts as the same screen as its holder. That buys nothing a
`tv:claim` does not already give any LAN device under the no-lockout rule, so it is not a defect; never build
authorization on the seat.

### Schema and migrations

`src/lib/server/db/schema.ts` is the index; `meta/<id>.json` sidecars are authoritative for media identity
(`docs/ARCHITECTURE.md` §6).

- **A Drizzle `enum` on a text column is NOT enforcement.** It generates no `CHECK` constraint, so the
  column enforces `NOT NULL` alone — never an enum and never finiteness — and an out-of-vocabulary value
  persists SILENTLY. Validate before the write; the enum's values are read only to CLASSIFY. What
  write-behind persistence actually rejects is a null or missing value, which crashes the flush; an
  off-vocabulary string or a non-finite number goes through.
- **A client may only ever mint `queued`.** The add arm's allowed set is that single literal and NOT the
  column's enum membership, because `playing` and `done` are real column values but server-owned lifecycle
  states.
- **A multi-statement write runs in ONE synchronous transaction.** The repository's delete-then-insert paths
  (removing a media, replacing its tags) would otherwise leave orphaned rows behind a crash.
- **`jobs` carries a PARTIAL unique index** on `(media_id, job_type)` excluding terminal statuses. That is
  the dedup guarantee, enforced by the DB even when a dispatch race slips past the application check, and
  excluding terminals is what lets a song be re-processed after a failure or a cancel.
- **`plays` is unique on `entry_id`.** That durable index is the idempotency guarantee for play counting —
  the in-memory dedup is not trusted alone, and without it a restart double-counts the song on screen.
- **`job_attempts` is deliberately unique on nothing but `id`.** A second attempt is a second row.
- **Column defaults are part of the contract.** Every `room_settings` and `global_settings` column carries
  a `NOT NULL DEFAULT` matching the TypeScript default, so an inserted row is valid without the
  application, and a migration backfill can rely on it. `DEFAULT_STAGE_COLOR`'s exact bytes are one of
  those defaults, which is why it is a literal rather than a computed value.
  **CHANGING ONE COSTS A MIGRATION, AND IN SQLITE THAT MIGRATION RECREATES THE TABLE.** `0001_lyrics_lead_default`
  is the first (the display lead's default 0 -> 40, W5): SQLite cannot `ALTER` a default, so `drizzle-kit`
  emits `CREATE TABLE __new_room_settings` + `INSERT … SELECT` + `DROP` + `RENAME` inside
  `PRAGMA foreign_keys=OFF`. That is drizzle's standard ALTER for this dialect and it PRESERVES every row — it
  is not the baseline re-cut below, which rewrites history and discards databases. The rule it does not break:
  the contract is the source of truth, so change `DEFAULT_*` first, then the column, then
  `bun run db:generate --name <what_changed>`, never the reverse
  (`tests/unit/server/db/room-settings-defaults.test.ts` fails on any drift, and nothing reads the column
  default at runtime).
  **AND BECAUSE NOTHING READS IT AT RUNTIME, A CHANGED DEFAULT REACHES NO EXISTING ROW** — `setRoom` writes
  every column on every save, `getRoom` returns the stored row verbatim — so a default change that is meant to
  reach existing rooms needs a BACKFILL in the same migration, and must say why overwriting a stored value is
  defensible. `0001` carries one (`UPDATE room_settings SET lyrics_lead_ms = 40 WHERE lyrics_lead_ms = 0`): the
  knob shipped at 0, so a stored 0 and the old default cannot be told apart, and pre-release is the only window
  in which that is true (W5 review r1-spec-15 / r1-tests-18;
  `tests/unit/server/db/lyrics-lead-backfill.test.ts` stages the baseline, saves a room, then upgrades).
- **Migrations are frozen history — from first release, not from first commit.** `drizzle/0000_baseline.sql`
  is the SINGLE PRE-RELEASE BASELINE: one file, pure `CREATE TABLE`, no `ALTER`, and one journal entry. A
  schema change is a NEW numbered migration plus its journal entry, and one that only ever `ALTER`s; never
  edit a committed migration's statements or reorder them.
  **The one exception, and it expires:** while there is no deployment to upgrade, the baseline may be RE-CUT
  rather than grown — delete `drizzle/` and regenerate with `--name baseline`, which absorbs every `ALTER`
  into the `CREATE TABLE`s. That has been done once, collapsing four migrations (`0001` a schema revision,
  `0002` the `job_attempts.trail` column, `0003` the `room_settings` default parity fix) back into `0000`.
  It is a HISTORY REWRITE: every existing database fails to boot afterwards, because the baseline's hash no
  longer matches the one recorded in its `__drizzle_migrations`, and drizzle then replays `CREATE TABLE`
  against tables that already exist. Every such database must be discarded, so this stops being available the
  moment one exists that anybody cares about. `drizzle-kit` will not regenerate into a `meta/` directory that
  exists but holds no `_journal.json`; remove `meta/` and it writes its own.
- **Widening a Drizzle enum needs NO migration**, precisely because the column is plain text with no
  `CHECK`. The corollary is that a hand-edited database can smuggle an unknown value into any column the
  application does not normalize on read.
- **`rooms.code` is uniquely indexed and an insert RETRIES on collision.** The index is the collision
  safety; the retry is what keeps a collision from surfacing as a failed join.
- **These NULLs mean something specific and losing the distinction strands data:** `song_profile` NULL means
  the job has not run (the gate reads still-processing) whereas an all-null profile INSIDE the JSON means
  analysis ran and found nothing (a finished song); `guide_mix_ref` NULL routes to the two-element path;
  `background` / `guide_level` NULL mean inherit the room; `artist_canonical` / `title_canonical` NULL mean
  the parse was not confident, and a wrong guess is worse than nothing.
- **A room id is always required.** `src/lib/server/state/settings-repository.ts` takes it as an argument
  and there is no default-room constant anywhere in `src/**` or `server.ts` — a fallback id is how one
  party writes another party's settings.
- **A restored song must come back with its artifact keys.** Dropping one from hydration replays a song
  with stems but silently without its lyrics overlay.

### Media storage and paths

The four storage classes, the ref layout and the audio policy are in `docs/ARCHITECTURE.md` §6.

**Identity and authority.**

- **`sourceRef` is immutable.** Search dedupes on `(source, sourceRef)`, so overwriting it with an artifact
  path forks one song into two rows — the processed one in the library, a fresh unprocessed one on the next
  search — and makes the result unmatchable against its own future searches. IDs name files, never titles.
- **The sidecar is authoritative and SQLite is a rebuildable index.** A sidecar write must never downgrade
  a citation to a re-parse, and a `high` citation may never be overwritten by a `medium` one; that rule
  needs memory, so it holds in all three layers at once.
- **Status and artifact are written by separate steps, and the ORDER matters**: publish the artifact, then
  flip the status. A status running ahead of its ref hands the player an empty source.

**Paths and bytes.**

- **A ref's first segment selects its root**, and `safeMediaPath` in
  `src/lib/server/media/local-files.ts` performs containment PER ROOT — never against the media root
  globally, because a class directory may legitimately point outside it. It is the single containment
  authority, shared by the `/media` route and its test so "what is safe to serve" cannot drift; a join that
  skips it serves any file the process can read.
- **A store answers BYTES, never a URL.** There is no presigned or direct link and no `url()` member to
  re-add, which is what keeps media same-origin.
- **The raw audio's real extension is recorded nowhere.** Any consumer must enumerate every known extension
  rather than trust one key: a superset costs nothing, while naming one too few permanently orphans the one
  storage class that cannot be regenerated.
  **Durability and deletion.**

- **A sidecar is written to a unique sibling temp file and RENAMED over the target.** An in-place write
  leaves partial JSON on the authoritative record after a crash or a full disk. Every sidecar schema change
  must be strictly ADDITIVE, so an absent field reads as "never ran" and no migration step is needed, and a
  partial record must be rejected by the well-formedness check before any section is dereferenced. A MISSING
  sidecar is normal and silent; one that exists and will not parse is logged, because that song's source of
  truth is gone.
- **Clearing artifacts must NULL the sidecar fields directly**, never rely on a merge that falls back to the
  previous sidecar — that resurrects just-deleted refs and republishes an evicted song as processed with
  refs to files no longer on disk.
- **Delete order: unlink the SIDECAR before the DB row.** A crash between them otherwise lets a rescan
  resurrect the song from the sidecar that is still there. The delete path must also delegate to retention's
  ref enumeration rather than keep a rival one.
- **Eviction is derived-only and true-LRU.** `audio/` and `meta/` are never touched: audio cannot be
  re-acquired once its source disappears, and meta IS the library. Only `derived/` is evictable, because it
  regenerates from a re-process.
- **`protectedIds` (the playing song plus everything queued) is enforced INSIDE the pure planner**, not left
  to callers, so no caller can forget it. A protected song still COUNTS toward the total, so an unreachable
  cap reports "evict everything allowed" rather than under-reporting pressure.
- **A lossy stem is never recompressed to FLAC** — lossless cannot recover discarded data, it only bloats
  the file. Only a legacy uncompressed stem is recompressed in place.

## Jobs and the worker

### The attempt ledger

`jobs` is the DISPATCH SLOT: exactly one live row per `(mediaId, jobType)`, mutated in place. `job_attempts`
is the history. The narrative is in `docs/ARCHITECTURE.md` §7; these are the invariants.

- **The two tables exist because dedup and history are incompatible in one row.** A retry reuses the `jobs`
  row, so there is nowhere in it to put a second attempt, and `updatedAt` is overwritten by every progress
  frame. An unrecorded duration is gone permanently.
- **An attempt row is APPEND-ONLY**: opened when the job enters the queue, filled in as that one attempt
  progresses, and NEVER written again once it has an outcome. A retry opens a new row.
- **Four clocks — `enqueuedAt`, `assignedAt`, `startedAt`, `finishedAt` — and each stays null until its
  moment happens.** A job nothing picked up has no `startedAt`, and writing `0` there invents work that
  never ran. Every reported duration is a subtraction between two of them.
- **`processingId` groups a run; `mediaId` cannot.** A song can be processed more than once, so grouping by
  media blends distinct runs and makes an end-to-end duration meaningless. `stems-upgrade` therefore starts
  a NEW process rather than inheriting one: it is background work on an already-finished song, and folding
  its cost into the process that delivered a singable song would make every average a fiction.
- **The resolved engine / model / backend / device / asrModel / syncMode are NOT re-derivable later.** They
  resolve from operator-editable global settings at dispatch, so reading today's settings to explain a past
  process answers confidently wrong. Written at assign time from the dispatched params, then overwritten by
  the worker's own reported resolution. `backend`, `device` and `threads` are the assigned worker's profile
  from its `worker:hello` (`WorkerProfile`, shape-checked by `workerProfile`), stamped at assign so a failed
  or abandoned attempt still records what it ran on. `threads` is torch's in-process count (alignment, the
  song profile, diarization), not the demucs subprocess's or whisperx's. An align completion overwrites
  `device` with its transcriber's (`cpu` on a Mac, where separation runs on `mps`). A completion fact that
  is not a bounded string is dropped (`resolvedFacts`), and a completion `backend` or `device` must be a
  name hello would accept, so a `null` cannot blank what assign wrote and no path lands in those columns.
- **`audioSec` is snapshotted onto the attempt**, not joined from `media`, because a media row's duration
  can be re-annotated later and would silently rewrite historical rates. Every reported cost is a rate.
- **The named lifecycle helpers are the only supported way to touch a job row.** Writing a status directly
  bypasses the ledger and leaves no trace of the attempt.
- **Inside a transition the order is fixed: SEAL the dying attempt BEFORE the status write, OPEN the fresh
  one AFTER it.** Sealing first dates the abandonment from the pre-transition attempt; opening after means
  the new attempt's 1-based number counts the row just sealed. Reordering either breaks attempt numbering
  and duration accounting at once.
- **The attempt number is derived from the ROW COUNT, not from `job.attempts`.** `job.attempts` is
  deliberately not incremented on an ack-timeout, since no work was performed, so using it undercounts
  physical attempts.
- **An inapplicable fact is recorded as NULL, never as a placeholder.** A fabricated engine on a `fetch` row
  corrupts every per-model rollup. A worker's report overwrites only the fields it actually reports, so a
  partial report can never blank out what dispatch recorded as the request.
- **A window over finish TIME, not a row-count cap.** A process straddling the window edge must be flagged
  `clipped` and excluded rather than measured from its surviving rows, which understates its duration.
- **The ledger is observability and NEVER a failure mode.** It is optional on the repository, and a
  lifecycle event with no open attempt is a no-op rather than a throw — otherwise deploying it with jobs in
  flight fails on the first completion.
- **Transitions are keyed on the EVENT, never on the status pair**, because a pair is event-lossy:
  `assigned → queued` is both `REJECT` and `LEASE_EXPIRED`, and `running → queued` is both a progress-lease
  expiry and boot `RECOVER`. Keying on the event is also what makes `REPRIORITIZE`, a status-free
  scheduling write, a legal edge of the machine rather than an escape hatch around it.

### The dead turn

A DEAD TURN is a queued entry whose song can never become singable: the rotation holds its slot and skips
it on every pass. It is made by the compound "make karaoke" action half-landing — the queue add succeeds,
the process half does not — or, which is what actually happened on the owner's box, by the process landing
and its `fetch` job dying 120 s later for want of a connected worker.

- **A queued entry is dead iff `!readyToSing(media)` AND no OUTSTANDING job for it**, where outstanding is
  `findOutstandingForMedia`'s rule: a `fetch`/`stems`/`align` job that is not terminal. Both halves are
  reused, never restated — `readyToSing` is the shared gate table and the job half has a one-select twin,
  `mediaWithOutstandingJob`, pinned against the per-media walk by a parity test.
- **`findLive` RETURNS a terminal `ready` job**, since only `failed`/`canceled` free the dedup slot. A
  predicate built on its truthiness calls every finished song "still working", which inverts this test.
- **The answer is DERIVED on every read and MARKED NOWHERE.** There is no `stem_status: 'failed'` (a dead
  process settles back to un-processed by design, so a mark would un-reprocess the song forever), no new
  `EntryStatus` (it would be a parallel mechanism to `isTerminal`/`applyAndReseq` and would race the add
  that `QueueStore.resendPending()` re-sends on resync), and no cancel — cancelling is the rollback that
  deletes a turn the guest genuinely asked for the moment the refusal was transient.
- **Ledger-only, not `stem_status`-based.** `settleStemsGate` resets that column to `'none'`, so the media
  row erases the failure by design, and `TerminalFailureDeps.persist` is optional in the type — a
  column-based predicate is hostage to every terminal path remembering to pass a sink.
- **Nothing is broadcast, because the phone derives the card better than any frame could say it.** Every
  `queue:sync` carries the media, so `queueCardKind`'s unacquired arm already draws the --warn stalled card
  with its retry; the only thing `media:status` can say is `'failed'`, which takes that retry away and
  claims a process ran. The missing witness was the OPERATOR's: a boot census plus a per-pass warning when
  a turn newly dies, on the reaper's existing `onTick` (core keeps exactly two periodic timers).
- **Two consecutive passes, not a grace constant.** `processAndQueue` starts the job before it adds the
  turn, so Sing leaves no window where a turn exists and no job does; the grace stays for a tab still
  running the old queue-first code, and requiring the same song twice closes that with no number to defend.
  A server-side `addedAt` grace would also be sound, since the hub re-stamps `addedAt` from the room's own clock; the same comparison on a CLIENT is cross-clock and is not.

### Idempotency and the process cap

- **The dedup key is `(mediaId, jobType)` over non-terminal statuses**, enforced by a partial unique index
  as well as by the application. Note that a `ready` job still OCCUPIES the slot — only `failed` and
  `canceled` free it — which is why unblocking a re-run means explicitly superseding the terminal occupant
  rather than enqueueing past it.
- **`clientOpId` is the queue-op idempotency key.** A replayed op re-acks without a state change, and the
  patch then omits `entries` because nothing moved. Every reducer arm is a no-op for an unknown id.
- **`plays` dedupes on `entryId` via a unique index**, so a restart cannot double-count the song that was
  on screen.
- **The per-singer cap counts live process JOBS, never queue entries.** The entry rides the WebSocket and
  the process rides HTTP, and only the entry is droppable — a phone tapping Sing while its socket
  reconnects files a process with no entry to count, so an entry-derived cap admits every tap.
- **`PROCESSES_UNCAPPED` (0) must be tested BEFORE any `count >= cap` comparison.** A comparison reached
  with `0` refuses the first request of every party. See [Settings scopes](#settings-scopes).
- **`processState` evaluates in a fixed order, and it is not cosmetic.** `not-processable` is a permanent
  property of the song, so it is decided before `playing` / `ready` / `processing` / `over-limit`, which are
  states a song passes through; `over-limit` is evaluated LAST, and only when a singer is named.
- **`Job.singerId` is `null` for internal callers** — lyrics backfill, chained follow-ups inheriting their
  parent's attribution — and a `null` imposes no cap. Attributing background work to a singer spends their
  quota on work they did not ask for.
- **Settings must be threaded to BOTH `processState` and `requestProcess`.** One resolves the over-limit
  check and the other the fetcher choice; supplying it to only one path makes the deployment's
  `defaultFetcher` silently miss every HTTP-requested process.
- **Follow-ups CHAIN and are never enqueued together.** `fetch → stems → align`: each step's input does not
  exist until the previous finishes, so enqueueing them together races producer against consumer for the
  same cores. `stems-upgrade` is an optional extra chain, gated by a setting.
- **`inheritsProcess` controls the process id AND singer attribution together.** A chained step keeps the
  parent's process id so its duration folds into that process; `stems-upgrade` takes a NEW, unattributed
  process id, so background re-separation neither corrupts the end-to-end figure nor spends a singer's cap.
- **Gate settlement is ONE table read by two callers** — one for a job that just died, one for boot-time
  staleness — so the per-type mapping cannot drift between the two directions. A gate's in-flight predicate
  counts only the explicit `queued` marker: a null or absent status means "predates this gate" or "never
  started", and settling either forges a step that never ran.
- **Cancellation settles only the gate its job type maps to, and only when something was actually
  cancelled.** A no-op cancel must never touch an unrelated media's status.
- **Slot release is EVENT-keyed, and the set is `REJECT` and `COMPLETE` only.** A lease expiry and a boot
  recover are excluded because the registry reclaims those slots itself on heartbeat or session drop; a
  failure is excluded because it is not exclusively worker-reported — the reaper and the unservable TTL also
  fail jobs. A worker-reported failure releases explicitly at its own call site, guarded on the job's worker
  id matching the reporter, which is what proves the worker is alive to release for.
- **Reprioritizing bypasses the state machine on purpose**, because `queued → queued` is not a legal edge,
  and it can only ever LOWER a priority number. That is what makes it safe to call unconditionally on every
  queue add.
- **Priority is the earliest `rotationSeq` needing that media, not FIFO.**
- **Leases:** `ackTimeoutMs` is 10s (grace to `job:accept` after dispatch) and `progressLeaseMs` is 30s
  (grace to the next progress frame while running). The lease KIND is inferred from the job's status and is
  not stored. An `assigned` expiry requeues with `attempts` UNCHANGED, because the worker never started; a
  `running` expiry BURNS an attempt, because the worker is assumed dead. `maxAttempts` defaults to 3, and
  `attemptsExhausted` is the one place that rule is written — the reaper and the `job:failed` handler both
  call it rather than re-testing the comparison. The heartbeat interval advertised to a worker is
  deliberately HALF the progress lease, so one dropped tick cannot breach it.
- **The reaper's `onFailed` hook must stay wired.** The reaper has no catalog access, so the app settles the
  song's readiness gate; skip it and a reaper-killed process leaves its gate mid-flight forever, holding up
  rotation. `onTick` fires on EVERY tick and `onReaped` only on a changed one — a purely time-based expiry
  folded into `onReaped` never fires, and parks its job `queued` forever.
- **Boot resets orphaned `assigned`/`running` rows to `queued`** through `RECOVER`, which is a distinct
  event precisely so the ledger can tell it from a lease expiry.
- **A job whose capability no connected worker advertises is flagged `unservable`** on `media:status`, and
  only when the song is not already playable — a stalled `align` follow-up on a published song is left
  alone, because missing lyrics is not missing audio.

### What the worker is told

The boundary runs one way: **the core decides what a process produces; the worker decides how its own box
executes it.** The full axis list is in `docs/ARCHITECTURE.md` §7.

- **Core-side, because they are persisted and feed the never-regress upgrade ladder:** separator engine and
  model, ASR model, sync mode, fetcher, lookup keys. If workers chose their own, two boxes would publish
  inconsistent instrumentals and a quality rank would mean nothing.
- **Worker-side, because they change throughput and not output, and only the worker can see them:** device,
  backend, thread counts, parallelism. All PROBED, never configured. An EXPLICITLY configured backend or
  device that turns out unavailable must RAISE at worker startup rather than silently downgrading.
- **A job DECLARES its fetcher; nothing infers one from a URI's shape.** The worker parses the declaration
  at its boundary, so an unknown value fails before a byte moves.
- **Capabilities are proven by a probe and matched on the action PREFIX.** Both axes namespace their tokens
  (`stems:roformer`, `fetch:ytdlp`), so a literal comparison rejects work the worker can genuinely run — and
  that refusal is invisible, because the core keeps the job `assigned` and the song sits at 0%. A token with
  no backing engine may be kept in the vocabulary but must never be ADVERTISED.
  `ENCORE_WORKER_CAPABILITIES` narrows the advertised set and can never extend it: a box claiming work it
  cannot do is indistinguishable from a hung worker.
- **Everything the worker reports UP is additive and optional**, so an older worker still completes a job:
  `worker:hello`'s `host` runtime block, and `job:complete`'s `facts`, `stages` and `selection`. A
  diagnostic must never fail a handshake.
- **What the worker reports is a MEASUREMENT, never a setting.** `cpuCount` is the EFFECTIVE count (the
  tightest of host cores, scheduler affinity and the cgroup quota), because a container throttled to two
  cores on a large host is the case worth knowing. `vramBytes` is physical capacity, so it says a card is
  big enough to consider and never that a checkpoint will fit beside what is resident. `accelerator`
  supersedes the `cuda` boolean, because ROCm masquerades as `cuda` in torch's API.
- **`ResolvedFacts` is what ACTUALLY ran, and it routinely differs from what was asked**: a processor
  applies its own default for an absent model, resolves a token to a checkpoint, and falls back to CPU when
  a requested backend will not load. Metrics built from dispatched values report requests as facts.
- **`StageTiming` is the split the core cannot see.** The core derives total time from its own
  accept→complete stamps; only the worker observes a stage transition, and it measures from the progress
  stream it already emits, so no processor contains timing code.
- **Every artifact key the worker writes must be DECLARED in `JobArtifacts`**, and the nesting is part of
  the declaration. With the core reading one level and the worker publishing another, the key arrives
  `undefined` on every process, each side's tests pass against its own mock, and because the `stems` gate
  requires the profile PRESENT every separated song stalls forever. `songProfile` is a SIBLING of `stems`,
  never a member, because `stems` holds file keys.
- **A declared type is not a validated one.** Normalize an incoming frame at the boundary
  (`normalizeSongProfile`) — it is untrusted.
- **The worker never branches mid-plan.** Every divergence resolves in `plan_for` before the first step
  runs; a conditional skip is `Step.applies`, an early finish is `StepResult(STOP, reason=…)`. RETRY belongs
  to the CORE, because the core owns the attempt ledger — a worker-internal retry loop would report one
  process where three engines were tried.
- **Annotation is best-effort by construction.** A declined match, an unreachable service or a disabled
  flag all leave the normalizer's values in place and must never fail a process: a karaoke night does not
  stop because a metadata service is down.
- **The MusicBrainz gate is process-global and SERIALISED**, with bounded exponential backoff on a 503 and
  the wait off the event loop. The published limit is one request per second per source IP and the penalty
  is TOTAL rather than partial, so a per-client interval check is not enough — two clients in one process,
  or two fetch jobs racing an unlocked timestamp, produce exactly the burst that gets an IP refused. A
  blocking wait would also stall another job's progress reporting and expire its lease.
- **In lyrics grading, ABSTENTION is what makes a weak baseline safe.** Agreement is null below
  `MIN_TOKENS_TO_COMPARE`, so a baseline that transcribed to almost nothing does not VOTE. Returning `0`
  instead makes it vote confidently against every correct candidate. "I cannot tell" and "these differ" must
  never be the same answer.
- **The absolute wrong-song judgement thresholds COVERAGE and never the ranking score**, and the
  TypeScript side is the authority the Python mirror matches — same expression, same operand order, so both
  produce bit-identical doubles. A machine-translated caption track is refused OUTRIGHT: it is fluent, long
  enough to clear the compare floor, and about the right song in the wrong language, so it would not
  abstain — it would vote confidently against every correct candidate.
- **`worker/encore_worker/protocol/frames.py` mirrors the `WorkerMessage` / `WorkerCommand` frame names**, and a parity guard
  asserts the two unions match. Adding a frame means adding it on both sides.

### Worker runtime

Rules that live in the worker process itself rather than in what it is told. The plan model is
`docs/ARCHITECTURE.md` §7.1.

- **Read config ON CALL, never snapshot it at import.** Host-derived values — capabilities, worker id,
  alignment device — are filled in by the startup resolve, so a module-level snapshot freezes to empty.
- **Drains run DETACHED from a dropped connection.** A blocking step is an uninterruptible native thread, so
  awaiting one inline holds the redial loop for a whole align pass; the task set pins them so they are not
  collected mid-flight, and cancellation stays synchronous so the subprocess still dies the instant the
  socket drops.
- **Validate a frame's required fields BEFORE touching state.** A raised key error escapes the read loop into
  the reconnect handler and tears down the socket, killing EVERY in-flight job on it for one malformed
  frame — so fail just that one job, and when there is no usable job id, log and drop the frame alone.
- **An unknown frame type is logged, not dropped silently**, or protocol drift is invisible from both ends.
- **Scratch is the worker's to delete, and it survives a RETRYABLE failure.** A core retry requeues the SAME
  job id, so the scratch directory resolves to the same path next attempt and each step's own
  "output already on disk" guard can skip what the last attempt finished, instead of re-downloading and
  re-separating from step one. A permanent failure falls through to cleanup like a success. The worker cannot
  tell an exhausted retry from a retryable one, so an exhausted job's scratch is reclaimed by the startup
  sweep instead. Core-side cleanup is not an option: a `rmtree` from the core hits a permissions error in any
  deployment where the two run as different users.
- **The cleanup must delete the path the PRODUCER computed**, not a hand-rebuilt copy of its layout, or the
  two spellings drift silently.
- **Refuse rather than complete dishonestly.** No downloaded file raises non-retryably; a digitally silent
  stem fails the job; and object-mode config with no uploader wired is REJECTED at assignment, because
  completing with a local path makes the core mark a song ready and then serve it from a store nothing was
  written to.
- **Retryability has one decision point.** A structured flag wins, else a permanent-marker table, defaulting
  to retryable. An explicit-but-unknown model token is PERMANENT: retrying re-resolves the same bad token
  forever.
- **A provider gate is process-global and lock-serialised across the wait AND the in-flight request.** An
  unlocked check-then-fire race is exactly the burst that gets an IP refused; a 503 or 429 retries with
  bounded backoff while other transport errors surface immediately as "provider down" rather than a silent
  miss.
- **Engine resolution is a pure per-job fold, never shared-instance mutation**, or concurrent jobs race each
  other's cached weights. A box that proves a capability by import but resolves to a backend no engine backs
  must refuse at BOOT, not fail every job at plan selection.
- **Step order carries real dependencies:** diarization runs after word timing and before publish, so it has
  words to attribute and can stamp parts before the doc is written; presplitting runs before grading, so a
  text demoted to low confidence is never handed to the line-splitter.
