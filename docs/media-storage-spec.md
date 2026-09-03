# Encore — Media Storage & Library Metadata (B-7 spec)

> **Status:** draft for review · **Author:** agent session 2026-09-02 · **Supersedes:** nothing
> **Blocks:** B-3 (tiered lyrics source chain) — the lyrics chain needs the metadata normalizer and
> the provenance convention defined here.

---

## 1. Why

Three problems, one root cause: **there is no storage design, only accumulated convention.**

1. **Raw audio is stored by accident.** The downloaded original lands in
   `media/stems/_work/<mediaId>/source.wav` — a scratch path, inside the *stems* namespace, that
   nothing ever cleans up. As of writing that is **432 MB of the volume's 1.2 GB across ~8 songs**.
   It is simultaneously our most expensive asset (re-acquiring it needs network + yt-dlp, and is
   impossible once a video is taken down) and the one thing treated as garbage.
2. **Nothing can be browsed.** The `media` table has `artist`, `title`, `durationSec`, `thumbnail`.
   `artist` is the **YouTube uploader**, not the artist — in the live library four of five rows read
   `Evolve`, `Musictainment TV 🇺🇸`, `Mohamad Hafiz`, `7clouds`, with the real artist buried in the
   title (`"Britney Spears - Baby One More Time (Lyrics)"`). There is no album, year, genre, or tag
   anywhere. "Browse by artist/genre" is not a UI task; it is a data task.
3. **Nothing is evictable and nothing is portable.** ~150 MB/song means a 50-song night is ~7.5 GB
   with no cap and no eviction. And the volume is not self-describing: blow away the SQLite file and
   every title, artist and cooked-artifact link is gone even though the bytes are all still there.

## 2. Requirements (from the owner)

- Storage root(s) **passed in via docker compose** so they can be volumes.
- **Separate paths** for raw audio vs metadata.
- Enough **markup** to browse the library by **artist / genre / etc.**

## 3. Storage classes

Split by **replaceability**, because that is what decides backup policy, eviction policy, and what an
operator may safely delete. Four classes:

| Class | Holds | Regenerable? | Policy |
|---|---|---|---|
| **state** | SQLite (queue, singers, playback, job ledger, library index) | from `meta` + a rescan, except live party state | back up cheaply; small |
| **audio** | the raw original per song | **No** — needs network, and may become unavailable forever | the thing to actually back up; never auto-evict by default |
| **derived** | instrumental + vocals stems, pitch track, lyrics JSON, thumb cache | Yes — CPU only, from `audio` | safe to nuke; first to evict under pressure |
| **meta** | one sidecar JSON per song | it *is* the truth | tiny, hand-editable, portable |

### Env surface

```
ENCORE_DATA_DIR      default ${MEDIA_ROOT}/../data   sqlite (WAL)
ENCORE_AUDIO_DIR     default ${MEDIA_ROOT}/audio     raw originals
ENCORE_DERIVED_DIR   default ${MEDIA_ROOT}/derived   stems / pitch / lyrics / thumbs
ENCORE_META_DIR      default ${MEDIA_ROOT}/meta      sidecar JSON
MEDIA_DIR            default ./media                 the root the above default under
MEDIA_STORE          local | object                  unchanged (S3/MinIO for remote workers)
```

`MEDIA_DIR` stays the single root and every new dir **defaults to a subpath under it**, so an
existing install keeps working with no env changes and no file moves. Each can be pointed at its own
volume independently — which is the point: put `audio` on the big slow disk, `derived` on the fast
one, back up `meta` with the dotfiles.

### compose

```yaml
core:
  environment:
    - MEDIA_DIR=/app/media
    - ENCORE_AUDIO_DIR=/app/media/audio
    - ENCORE_DERIVED_DIR=/app/media/derived
    - ENCORE_META_DIR=/app/media/meta
  volumes:
    - ${ENCORE_DATA_VOLUME:-./data}:/app/data
    - ${ENCORE_MEDIA_VOLUME:-./media}:/app/media
```
Host-side paths become `${...:-default}` so they are overridable from a `.env` without editing the
compose file. The worker mounts the same media volume (single-box mode) exactly as today.

### Key layout

```
audio/<mediaId>.<ext>                     raw original (promoted from stems/_work/*/source.wav)
derived/stems/<mediaId>-instrumental.wav
derived/stems/<mediaId>-vocals.wav
derived/pitch/<mediaId>-pitch.json
derived/lyrics/<mediaId>.json
derived/thumbs/<hash>.jpg
meta/<mediaId>.json
work/<jobId>/                             scratch — ALWAYS deleted on job completion
```

**IDs, not titles, in paths.** Song titles carry unicode, emoji, slashes and duplicates; a
ULID-addressed layout is rename-safe, collision-free and filesystem-safe. Browsability is the DB's
and the UI's job, not the filesystem's. (If poking around with a file manager matters later, an
optional generated symlink tree — `by-artist/<artist>/<title>.wav` — can be added without touching
the storage model.)

**Migration** is a one-shot boot step: move `stems/_work/<id>/source.wav` → `audio/<id>.wav`, move
`stems/*` → `derived/stems/*`, `pitch/*` → `derived/pitch/*`, backfill `meta/<id>.json` from the
`media` table, and delete the rest of `_work`. Refs in the DB are rewritten in the same transaction.
Idempotent, and a no-op on a fresh volume.

## 4. Metadata: sidecar is the truth, the DB is an index

`meta/<mediaId>.json` is authoritative; the `media` table is a **rebuildable index** over it. This
buys three things worth more than the small write cost: the volume becomes **self-describing** (move
it to a new box, rescan, everything is back); the DB stops being a single point of permanent data
loss; and **genre/tags become hand-editable** with a text editor, which is how a self-hosted library
actually gets curated.

```jsonc
{
  "id": "01M1J2X9N1Y355J6R8PDN0A2GP",
  "schema": 1,
  "origin":   { "source": "youtube", "sourceRef": "Elj6ZTEtko4", "fetchedAt": 1788380384164 },
  "canonical": {
    "artist": "Marvin Gaye & Tammi Terrell",
    "title":  "Ain't No Mountain High Enough",
    "album":  null,
    "year":   1967,
    "genre":  ["soul", "motown"],
    "language": "en"
  },
  "provenance": {
    "artist": { "by": "youtube-title-parse", "confidence": "medium" },
    "title":  { "by": "youtube-title-parse", "confidence": "medium" },
    "genre":  { "by": "manual",              "confidence": "high"   }
  },
  "artifacts": {
    "audio":        { "ref": "audio/01M1....wav", "bytes": 26640466 },
    "instrumental": { "ref": "derived/stems/01M1....-instrumental.wav", "by": "demucs:htdemucs" },
    "vocals":       { "ref": "derived/stems/01M1....-vocals.wav",       "by": "demucs:htdemucs" },
    "pitch":        { "ref": "derived/pitch/01M1....-pitch.json" },
    "lyrics":       null
  },
  "library": { "tags": [], "addedAt": 1788380384164, "playCount": 3, "lastPlayedAt": 1788380455896 },
  "raw": { "uploader": "Musictainment TV 🇺🇸", "rawTitle": "Ain't No Mountain High Enough - Marvin Gaye x Tammi Terrell (Lyrics) 🎵" }
}
```

Two deliberate choices:

- **`raw` is never discarded.** Keeping the untouched uploader/title means a better normalizer (or a
  MusicBrainz lookup) can re-derive canonical fields later **without re-downloading anything**.
- **Every derived field carries provenance + confidence.** This is the same convention the tiered
  lyrics chain (B-3) needs, so the two features share one idea rather than inventing two. It is also
  what lets the UI be honest — a machine-parsed artist and a hand-corrected one are not equally
  trustworthy, and a `genre` from a guess should not look like a fact.

### The metadata normalizer — one function, two consumers

A pure `parseTrackTitle(rawTitle, uploader)` that turns
`("Britney Spears - Baby One More Time (Lyrics)", "7clouds")` into
`{ artist: "Britney Spears", title: "Baby One More Time" }`, stripping the usual noise
(`(Lyrics)`, `(Official Video)`, `[HD]`, `ft.`/`feat.` handling, `x` as a collaboration separator).

This is the highest-leverage piece in the whole task and it serves **both** features: browse-by-artist
needs it, and it independently takes LRCLIB's hit rate on the current library from 1-in-5 to ~5-in-5.
Pure, no network, fully unit-testable — the live library's five rows are the first five test cases.

### DB index additions

Add to `media`: `artistCanonical`, `album`, `year`, `metaSchema`. Multi-valued things go in their own
table so they can be indexed and browsed:

```sql
media_tags(media_id TEXT, kind TEXT, value TEXT)   -- kind: 'genre' | 'tag' | 'mood'
  INDEX (kind, value)   -- browse: every song of a genre
  INDEX (media_id)      -- render: every tag of a song
```
One table for genre and free tags keeps browse queries uniform (`WHERE kind=? AND value=?`) instead
of growing a column per taxonomy.

## 5. Audio formats — the single biggest lever

**WAV is a working format, never a stored one.** This is settled policy (measured, not estimated).

The old pipeline passed `-x --audio-format wav` to yt-dlp, which transcoded a lossy YouTube stream
into uncompressed WAV, then stored both separated stems as WAV too. WAV at 44.1 kHz stereo 16-bit is
10.6 MB/minute, so one 3½-minute song cost ~108 MB. The transcode gained **nothing**: you cannot
restore information YouTube already discarded, so the WAV was a lossless copy of lossy audio.

| | before | after | |
|---|---|---|---|
| raw original | 37.94 MB wav | **3.66 MB** webm/opus 148k | native stream, no transcode |
| instrumental | 34.86 MB wav | **4.96 MB** m4a/aac 200k | stereo AAC |
| vocals | 34.86 MB wav | **4.99 MB** m4a/aac 201k | retained — future vocal guide |
| **total** | **107.66 MB** | **13.61 MB** | **7.9× smaller, same song** |

Measured end to end on one media id cooked both ways (a 3:27 track), so it is a like-for-like
comparison rather than a projection.

The rules and why each is what it is:

- **Raw audio keeps YouTube's native container** (`-f bestaudio`, no `-x`, no `--audio-format`).
  Smaller *and* higher fidelity than any re-encode.
- **Demucs gets a transient decode.** `work/<jobId>/input.wav` at stereo/44.1k, deleted with the
  scratch. Normalizing here also makes separation behave identically for Opus-in-webm and AAC-in-m4a
  inputs.
- **Stems are stereo AAC in m4a at 192 kbps.** AAC rather than Opus **specifically for Safari** — the
  instrumental has to play in a browser `<video>`, and AAC-in-m4a is the safer bet there. 192k leaves
  headroom over a ~130-150 kbps source for the unavoidable second generation.
- **Stereo is the ceiling.** YouTube serves stereo, so a 5.1.2 receiver upmixes from stereo no matter
  what we store; anything beyond stereo would be invented data.
- **The vocals stem is retained, compressed.** Pitch extraction and the planned vocal guide both need
  it, and at ~5 MB it is no longer worth evicting. It stays in `derived`, so policy can still drop it.
- **Job scratch is deleted by the WORKER, not the core.** The worker created those dirs at its own
  uid, so a core-side `rmtree` gets EACCES in a two-container deployment. Cleanup lives with whoever
  created the files.

Older songs cooked before this policy keep their `.wav` refs and still play: the ref is stored
per-media, so the key helpers only name NEW output. The layout migration moves bytes and does not
transcode.

## 6. Retention

Two jobs with different costs, deliberately separated (B-7-C5).

**Recompress legacy formats — the right tool for pre-policy space.** Songs cooked before §5 carry WAV
stems ~8x larger than a cook produces today. Those bytes are already on disk, so they can be
transcoded IN PLACE: no download, no Demucs run, and **the song never leaves the library**. Eviction
would have been wrong here — it would have dropped 6 of 7 songs until re-cooked.

*Measured on the live volume:* `derived/` went **911 MB → 136 MB** (22 stems converted), all 7 library
songs still listed and all 7 serving 200 with their refs updated to `.m4a`.

Safety rules that matter: the legacy file is deleted only once the destination exists and is
non-empty (a large playable file beats a truncated one), each conversion is isolated so one failure
cannot abandon the rest, and a failed transcode leaves the original in place.

`-movflags +faststart` is attempted but not required. A host ffmpeg build can be leaner than the
worker container's, and one here was: a stripped ffmpeg 7.1.1 with **no AAC encoder and no mp4
muxer**, which failed all 12 conversions until the flag became optional and the log named the real
cause. The bundled container ffmpeg is full-featured, so the core-side pass is correct in the shipped
image; on a lean host the work belongs to the worker.

**Evict derived artifacts over a soft cap.**

- `ENCORE_MEDIA_MAX_GB` (default unset = unlimited) — a party box must not silently delete.
- Over the cap, evict **derived-only**, least-recently-used first, never touching `audio` or `meta`.
  A song stays in the library and re-cooks on demand; that is a delay, not a loss.
- Recency currently falls back to `addedAt`, because play tracking is not wired
  (`library.lastPlayedAt` is never incremented) — so it is oldest-added-first today. Worth upgrading.
- `work/` is deleted on job completion by the WORKER (not the core — see §5).
- Raw `audio` is never auto-deleted. Note that pre-policy `audio/` is still WAV (~494 MB here);
  re-encoding it would reclaim ~8x but costs a second lossy generation on the only unrecoverable
  class, so it stays an explicit human decision.

## 7. Open decisions

1. **Sidecar-authoritative (recommended) vs DB-authoritative.** Sidecar costs a small write per
   change and buys portability, hand-editing, and no single point of loss.
2. **Where does `genre` come from?** MusicBrainz lookup (free, needs network + a fingerprint or good
   metadata), manual tagging from the phone/TV, or both. Recommend: schema supports it now, manual
   tagging ships first, MusicBrainz later behind the same provenance field.
3. **Keep the four-way split, or collapse `meta` into `derived`?** Four dirs is more env surface; the
   split is what makes "which volume do I back up?" answerable.
4. **Do we cap by default?** Recommend no default cap (a party box shouldn't silently delete), but
   log a warning past a few GB.

## 8. Commit shape

- **B-7-C1** the pure metadata normalizer (`parseTrackTitle`) + the live library's rows as fixtures.
- **B-7-C2** the storage-class env surface, path resolvers, compose wiring, and the idempotent
  one-shot migration (promote `_work` audio, reshuffle into `derived/`, backfill `meta/`).
- **B-7-C3** sidecar read/write + rebuild-index-from-`meta` rescan; `work/` cleanup on job end.
- **B-7-C4** `media_tags` + the browse queries; manual tagging surface; genre/artist browse in the
  phone library UI.
- **B-7-C5** retention: soft cap, derived-only LRU eviction.
- **B-7-C6** ✅ *done* — audio format policy (native raw audio, stereo AAC stems, transient decode,
  worker-owned scratch cleanup). Ordered BEFORE C3 deliberately: sidecars record artifact refs, so the
  formats had to settle first.
