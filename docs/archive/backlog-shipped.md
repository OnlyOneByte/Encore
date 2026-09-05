# Archive — Shipped backlog items (B-1, B-5, B-6, B-7, and B-3's shipped commits)

> **Frame citations in this document are historical.** The `<id>-…-eyeson.png` files it names were
> retired when `docs/mocks/` was reduced to the one regenerable set (`tour-…`); the verification
> they record still happened, the image no longer ships. See
> [`docs/mocks/README.md`](../mocks/README.md).

> **Historical record. Nothing here is actionable.** Kept for the rationale — several of these
> entries record *why* a design went the way it did (storage split by replaceability, sidecar
> authority, the lyrics acquisition/timing split). Open work is in [`../ROADMAP.md`](../ROADMAP.md).

---

## B-1 · Saved-karaoke library · B-5 · readiness search · B-6 · TV room states

- [x] **B-1 · Saved-karaoke library + cooked-media persistence** (M9-C2 core) — *done, verified
  end-to-end against a real server restart.* `media` rows are upserted on search-materialize, on the
  make-karaoke request (cooking state), and on the ready flip (via a `persistMedia` seam on the
  worker hub); `getApp()` hydrates the runtime catalog from disk before anything reads it, so titles
  survive a restart and `requestMakeKaraoke` refuses to re-cook stems that already exist
  (`isCooked` / `cookState`). New `GET /api/library` + a phone "🎤 Karaoke library" section for
  one-tap re-queue that skips the worker, and a "✨ Cooking now" section that renders the
  ProcessingCard for a cooking song with no rotation row of its own (`ProcessingCard`'s `seq` and
  singer props are now optional). Migration `0004` adds `lyrics_ref` + `pitch_ref` so a library song
  keeps its lyrics overlay and scoring reference. **Two bugs the restart harness caught that unit
  tests could not:** (1) `server.ts` seeded its demo catalog unconditionally, overwriting a hydrated
  cooked song with a pristine iframe stub — it now seeds only what is missing; (2) the job dedup
  index counts `ready` as live, so `enqueue` can return a finished job — the media is now reconciled
  to it instead of being left `queued` against work that will never run (which held the entry out of
  rotation forever). Also fixed: search/library/shortcut results are merged into the client media
  catalog, or a cooking card rendered a raw ULID instead of the song title.
  **Verified:** AUTO — 14 new unit tests (repository round-trip + hydrate-no-clobber + boot round
  trip; `isCooked`/`cookState`; no-re-cook; ready-job reconcile), 237 core tests green, typecheck +
  build clean. EYES-ON — cooked a song through the real dial-home worker protocol, restarted the
  process, confirmed the library lists it with its instrumental key + lyrics + pitch intact, that a
  re-request answers `alreadyReady` with no new job, that the hub accepts a re-queue, and
  screenshotted both new phone sections.
- [x] **B-5 · One search on the readiness axis + pull-up queue sheet** — *done, verified in a real
  browser.* Three pieces, in dependency order:
  1. **`sourceRef` is now immutable origin identity.** `markMediaReady` used to overwrite it with the
     stem key, so a cooked song could never be matched against its own search result again — every
     search for it minted a fresh UNCOOKED duplicate and the library version was unreachable
     (reproduced live: cooked `demo-takeonme` kept `stems/…wav` while a new ULID row appeared with
     `djV11Xbc914`). The stem key moved to `Media.instrumentalRef`, players ask the new pure
     `playbackRef(media)` helper for "what to load", and migration `0005` adds the column and
     backfills rows cooked under the old scheme. Same fix repairs a latent second bug: `sourceUri`
     would have handed a worker `youtube.com/watch?v=stems/…wav` for any job after the first.
  2. **One unified search.** The `?source=youtube|local` switch is gone from the UI: `/api/search`
     queries every resolver, materializes + persists each hit, and returns three groups — `ready`
     (stems on disk) / `cooking` (stems in flight) / `results` (plays with vocals) — deduped so a
     song appears EXACTLY ONCE. A dead source (yt-dlp missing, no network) no longer fails the whole
     search, and a known-cooked song is still offered when the resolver returns nothing. Phone gets
     readiness filter chips with live counts, one `SongRow` shape for all three states, and honest
     sub-lines: a raw row says *"sings with the original vocals"*, so the ✨ Karaoke button's value is
     self-evident. Cooking rows keep `＋ Turn` — rotation already holds a cooking song's slot
     (M7-C6), so cooking is not a blocked state. `/api/library` also returns what is cooking with
     live pct, so reloading mid-cook no longer loses the progress bar.
  3. **Pull-up queue sheet.** The rotation moved out of the main scroll into a bottom sheet, so
     browsing and queue-checking stop fighting over one scroll. The peek carries the question people
     actually ask — *"You're #2 · after Maya"* — which used to sit in a card that scrolled off the
     top. Pointer-drag to pull (verified with real mouse events: sheet top 588→317 up, back down on
     pull-down), and never drag-only — tap, Enter, ArrowUp/Down and Escape all work. Peek height is
     MEASURED and published to `:root` as `--peek-h`, because a hardcoded guess left the body
     bleeding out below the peek.
  **Three bugs found by driving the real UI, none of which unit tests could catch:** (a) the same
  song rendered in Ready *and* Popular *and* Recently-queued at once — the shortcut lists now
  subtract whatever the readiness groups already showed; (b) `WsClient` passed bare `setTimeout` as an
  option and called it as `this.#opt.setTimeoutFn(...)`, throwing `Illegal invocation` in a browser,
  so the WS **heartbeat never armed and capped-backoff auto-reconnect (M5-C6) never scheduled** —
  silently dead in production while tests passed on injected fake timers; (c) the peek-height bleed
  above. `SongCard` was deleted (superseded by `SongRow`); the `/components` gallery now shows all
  three readiness states.
  **Verified:** AUTO — 249 core + 35 shared tests green (+12 new: readiness partition incl. the
  appears-exactly-once invariant, client/server classification agreement, `playbackRef`,
  origin-survives-the-cook), typecheck + build clean. EYES-ON — searched a previously-cooked song and
  confirmed it returns once as ready with zero raw rows sharing its origin; drove join → all three
  groups → drag up → drag down → keyboard toggles, and screenshotted collapsed + expanded.
- [x] **B-6 · TV room-state clarity (lobby + persistent join QR)** — *done, verified by driving the
  real server through all three states.* The TV used to collapse every non-playing situation into ONE
  attract screen (`isAttract = tvState === 'attract' || !current`), so "nobody is here" and "four
  people are here waiting for a first pick" looked identical and the screen could not say what it was
  waiting for. Four pieces:
  1. **Presence on the wire (C1).** The WS upgrade now resolves *which singer* a socket belongs to
     from the session cookie (`readSessionToken` on the handshake request) — previously every socket
     was anonymous, so presence was impossible. A ref-counted `PresenceTracker` (multiple tabs per
     singer; a singer goes absent only on their LAST socket close, or a reconnect would flicker them
     out of the roster) drives a new `singer:presence{online}` broadcast on the 0→1 and 1→0
     transitions, and `queue:sync` carries an `online` snapshot so a client joining mid-party gets the
     roster immediately instead of on the next change. Presence is the roster source, NOT the singer
     table: that table is append-only and file-backed (H-5), so it accumulates everyone who ever
     joined and would show a night's worth of ghosts.
  2. **The three-way screen (C2).** Pure `tvScreen()` derives `attract | lobby | waiting | playing`
     with `playing` > `waiting` > `lobby` > `attract` precedence, so the M7-C6 cooking hold still wins
     over the lobby. `lobbyRoster()` caps chips (8) and reports the overflow so a 20-person party
     cannot push the strip over the screen, and skips a present id with no name yet rather than
     rendering a nameless "Someone" chip.
  3. **Lobby, layout option B (C2).** Chosen over the alternative: the QR keeps the stage, "Waiting
     for someone to pick a song…" sits under it, and the roster runs along the bottom as a strip with
     each singer's identity color. With a rehydrated queue and nobody reconnected the sub-line says
     "Scan to join" rather than the untrue "0 in the room".
  4. **Persistent corner join card (C3).** One `JoinBadge` serves both placements (`hero`/`corner`).
     The corner card is pinned **bottom-right on purpose and must stay there**: the "Now singing"
     lower-third owns bottom-left and the M8-C3 `ScoreBadge` owns top-right, so bottom-right is the
     only free corner — a top-right QR sits under the score mid-song. It carries the URL as text and
     a live "N singers in" line, so a latecomer glancing at the TV can join without stopping the music.
  **One crash the real-server drive caught that no unit test would have:** an `add` command whose
  `singerId` was missing sailed through `validateCommand` into the persistence write, where
  `queue_entries.singer_id` is `NOT NULL` — the `SQLiteError` threw out of `state.apply()` and **killed
  the whole server process**. Any client could end the party with one malformed message. Now rejected
  like any other bad op, with two regression tests.
  **Verified:** AUTO — 19 new tests (presence ref-counting + sync-snapshot, screen precedence incl.
  cooking-beats-lobby and rehydrated-queue, roster cap/overflow/nameless-skip, the singerId crash),
  268 core tests green, typecheck + build clean. EYES-ON — drove the live server: empty room → attract,
  two phones join → lobby names both, one closes → their chip goes within ~2s, queue a song → playing
  with the corner card and no collision. `docs/mocks/b6-tv-lobby-eyeson.png`,
  `docs/mocks/b6-tv-cornerqr-eyeson.png`.

---

## B-7 · Media storage layout + library metadata (complete)

- [ ] **B-7 · Media storage layout + library metadata** — full spec:
  [`reference/media-storage-spec.md`](reference/media-storage-spec.md). Storage is currently accumulated convention, not design, and three
  things follow from that: (a) the raw downloaded original is retained **by accident** in
  `media/stems/_work/<mediaId>/source.wav`, a scratch path nothing ever cleans up — **432 MB of the
  volume's 1.2 GB across ~8 songs** — while being the one asset that cannot be regenerated if a video
  goes away; (b) nothing can be browsed, because `media.artist` holds the **YouTube uploader**
  (`7clouds`, `Musictainment TV 🇺🇸`) with the real artist buried in the title, and there is no album,
  year, genre or tag anywhere; (c) nothing is evictable (~150 MB/song, no cap) and the volume is not
  self-describing — losing the SQLite file loses every title and artifact link even though the bytes
  survive. Splits storage by **replaceability** into `state` / `audio` (unrecoverable) / `derived`
  (regenerable) / `meta`, each its own env-configurable path defaulting under `MEDIA_DIR` so existing
  installs need no changes, mounted as overridable compose volumes. Sidecar `meta/<id>.json` becomes
  authoritative with the DB as a rebuildable index, every derived field carries
  provenance + confidence (the same convention B-3 needs), and the untouched `raw` uploader/title is
  never discarded so a better normalizer can re-derive canonical fields without re-downloading.
  Browse comes from a `media_tags(media_id, kind, value)` table, not a column per taxonomy.
  **Done-when:** raw audio lives in `audio/` as a first-class asset with `work/` cleaned on job end;
  a `meta/`-only rescan rebuilds the library index from scratch; the phone can browse by artist and
  genre. **Verify:** AUTO — the pure normalizer against the live library's five rows as fixtures,
  migration idempotency, rescan round-trip, browse queries; EYES-ON — the browse UI.

---

## B-3 · Tiered lyrics source chain — the shipped commits (C2–C7 part 1)

The B-3 design rationale and its OPEN items live in the live roadmap; this is the shipped detail.

  - [x] **B-3-C2 · candidate model + `pickBestLyrics` (pure).** DONE. `packages/shared/src/lyrics.ts`:
        `LyricsCandidate` (textSource × timing × confidences + agreement), the 4-tier rank with
        authoritative+line **above** asr+word, `pickBestLyrics` (null = honest "no lyrics"),
        `mergeLyricsCandidate` (never-regress by keeping everything, keyed on ref), and
        `agreementScore` (Jaccard over token sets; returns null not 0 when too short, so an
        instrumental can't fail a correct lookup) + `isLikelyWrongSong`. 19 tests. **AUTO**.
  - [x] **B-3-C3 · split acquisition from timing in `whisperx.py`.** DONE. New `lyrics_chain.py` owns
        acquisition: `LyricsSource` protocol, `LyricsRequest`/`LyricsText`, `LrclibSource` (declines on
        missing metadata / 404 / instrumental / dead network — never raises), `acquire()` running
        EVERY source rather than first-hit, and `candidate_key()` giving one artifact file per text
        source so candidates coexist. `WhisperXProcessor` takes an injectable `sources` list, emits
        `artifacts.lyrics.candidates` (+ `uri` for back-compat), and `_time_one` applies timing per
        text: keep existing word timings → else force-align → else the source's own LINE sync → else
        DROP (an unsynced wall of text is below the floor). Missing `artist`/`track` no longer raises;
        plainLyrics are reported `timing: none`, NOT line-timed, since even spacing is not sync. New
        module rather than extending lyrics_source.py: the adapter needs `lrclib_to_segments`, which
        would close an import cycle. 11 new tests + 4 rewritten (one encoded the old conflation).
        **AUTO** with fake sources.
  - [x] **B-3-C4 · ASR tier (real ML).** DONE. `Transcriber` protocol + `WhisperxTranscriber`
        (faster-whisper via `whisperx.load_model`, `int8` on CPU since float16 is GPU-only, language
        AUTO-DETECTED rather than guessed) and `AsrSource`, which reads the VOCALS STEM and **declines
        rather than falling back to the mix** — worse words that look identical to good ones is the one
        outcome provenance cannot rescue. That stem dependency is why align is chained after stems.
        **REAL-ML VERIFIED here:** `base` on CPU, a 3:31 vocals stem → **31.5 s**, language `en` (0.85),
        9 segments of recognisable-but-garbled Britney ("Oh baby baby… I must confess, I still
        believe" alongside "Boy, you rock me planter I've been a spitter") — precisely the dubious-text
        profile the ranking assumes. Cost: ~31 s of ASR + one align pass on top of ~87 s of Demucs.
        Environment wrinkle: `torchcodec` logs `libavutil.{56,57}.dylib` dlopen failures and falls back
        cleanly — noisy, not fatal. 8 tests. Also corrected the tier table above from measurement.
  - [x] **B-3-C5 · multi-candidate storage + `chosen` threading.** DONE. `Media.lyricsCandidates` +
        `chosenCandidate(media)` (provenance is DERIVED from the candidate whose ref matches
        `lyricsRef` — no redundant fields to drift). `setMediaLyrics` now merges a reported set and
        re-picks with `pickBestLyrics`, normalising the absolute paths workers report, and refuses to
        clear a working `lyricsRef` when nothing in a new set is showable. Sidecar
        `artifacts.lyricsCandidates` at **schema 2** (schema-1 records still resolve via the stored
        pointer, reporting provenance as UNKNOWN rather than inventing one); `chosenLyricsRef()`
        RE-PICKS on restore so a ranking change corrects itself instead of freezing into the record.
        Index copy as one JSON column (migration `0008`) since nothing queries inside the set, with a
        tolerant parse so a corrupt blob cannot brick a hydrate. 9 tests, incl. the regression guard
        (a late line-level source cannot displace stored word timings) and the index-only-rewrite case
        that would otherwise silently destroy the set. **AUTO**
  - [x] **B-3-C6 · TV honesty + the line-sync floor.** DONE. `lyricsNotice()`/`isAutoTranscribed()` in
        `tv/lyrics.ts` (pure, 6 tests) + a `provenance` prop on `LyricsOverlay`, fed from
        `chosenCandidate(media)` on the TV route. Auto-transcribed text renders ITALIC with a small
        permanent caption "auto-transcribed · words may be wrong"; deliberately **not dimmed**, since
        these are still the words to sing from and hurting legibility would punish the singer for a
        provenance problem. Notice is permanent rather than a toast — someone glancing up mid-song still
        needs to know. UNKNOWN provenance (pre-candidate artifact) renders like verified text and says
        nothing: we can assert neither. The line-sync floor already worked (whole-line highlight +
        next-line preview) and is now pinned in the gallery. `isAuthoritativeText` relaxed to a `Pick`
        so the client can call it with provenance alone. **EYES-ON:** three gallery variants
        (verified / auto-transcribed / line-only), asserted by DOM geometry rather than eyeballed —
        `docs/mocks/b3c6-lyrics-provenance-eyeson.png`. Also corrected the stale ASR row in
        `shared/lyrics.ts`'s header comment (the C4 measurement).
  - [x] **B-3-C7 (part 1) · the lyrics BACKFILL — the upgrade path's entry point.** DONE. `followUps`
        only fires on a stems COMPLETION, so lyrics existed exclusively for songs cooked after C1.
        Measured on the live library: **13 cooked songs, 3 with lyrics — 10 that could never get them**,
        since re-cooking was the only route and nobody re-cooks a working song. The whole multi-candidate
        design was justified by an "upgrade path" that had no way in. `needsLyricsBackfill()` (pure, 8
        tests) selects cooked songs lacking WORD timings and app.ts enqueues them at
        `BACKFILL_PRIORITY` = MAX_SAFE_INTEGER, so a live singer's cook always jumps the entire queue;
        dedup on `(mediaId, jobType)` makes restarts idempotent. `ENCORE_LYRICS_BACKFILL=0` skips it.
        Skips songs already at word timings (an ML pass could not rank higher) and bare schema-1
        `lyricsRef` records (may already be word-timed). **VERIFIED live:** boot queued exactly 10.
