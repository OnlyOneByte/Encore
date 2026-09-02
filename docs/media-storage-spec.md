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

## 5. Retention

Nothing is evicted today. With ~150 MB/song that is a 7.5 GB night.

- `ENCORE_MEDIA_MAX_GB` (default unset = unlimited) — a soft cap.
- Over the cap, evict **derived-only**, least-recently-played first, never touching `audio` or `meta`.
  A song stays in the library and re-cooks on demand; that is a delay, not a loss.
- `work/` is deleted on job completion, success or failure. (Today it is not — hence the 432 MB.)
- Raw `audio` is never auto-deleted. If it ever needs to be, that is a separate explicit decision,
  because it is the only unrecoverable class.

## 6. Open decisions

1. **Sidecar-authoritative (recommended) vs DB-authoritative.** Sidecar costs a small write per
   change and buys portability, hand-editing, and no single point of loss.
2. **Where does `genre` come from?** MusicBrainz lookup (free, needs network + a fingerprint or good
   metadata), manual tagging from the phone/TV, or both. Recommend: schema supports it now, manual
   tagging ships first, MusicBrainz later behind the same provenance field.
3. **Keep the four-way split, or collapse `meta` into `derived`?** Four dirs is more env surface; the
   split is what makes "which volume do I back up?" answerable.
4. **Do we cap by default?** Recommend no default cap (a party box shouldn't silently delete), but
   log a warning past a few GB.

## 7. Commit shape

- **B-7-C1** the pure metadata normalizer (`parseTrackTitle`) + the live library's rows as fixtures.
- **B-7-C2** the storage-class env surface, path resolvers, compose wiring, and the idempotent
  one-shot migration (promote `_work` audio, reshuffle into `derived/`, backfill `meta/`).
- **B-7-C3** sidecar read/write + rebuild-index-from-`meta` rescan; `work/` cleanup on job end.
- **B-7-C4** `media_tags` + the browse queries; manual tagging surface; genre/artist browse in the
  phone library UI.
- **B-7-C5** retention: soft cap, derived-only LRU eviction.
