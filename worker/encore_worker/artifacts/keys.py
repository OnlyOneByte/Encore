"""Store KEYS — a byte-for-byte mirror of core's `core/src/lib/server/media/paths.ts`.

WHY A MIRROR AND NOT A DERIVATION. The key is the contract between two processes in two languages. The TV
resolves `/media/${ref}`, so a disagreement is SILENT: the worker writes a real file, core records a real
row, and the player 404s. core's own header says it outright — "a mismatch is SILENT". Nothing at runtime
can catch that, so `tests/test_artifact_keys.py` parses `paths.ts` and asserts this module agrees.

WHY THE WORKER MUST NOT INVENT KEYS. A ref is not "where the file happened to land" — it is derived from
the media's IDENTITY, then bytes are placed at it. The reverse (publish wherever the separator wrote, then
describe it) is what put refs into `work/` job scratch, which core evicts.

PURE. No I/O, no env, no config: every function is a string template. `local.py` turns a key into a path,
and it is the only thing that knows where a class root lives.

EXTENSIONS ARE PARAMETERS, NOT CONSTANTS, even though defaults are given. Core announces the format it
wants in `worker:welcome`, and a row processed under an earlier setting keeps its own ext forever — so
every consumer has to be able to name an ext rather than assume today's.
"""

from __future__ import annotations

# ── audio: the one unrecoverable class ───────────────────────────────────────────────────────────

#: Newest-served first. Nothing records the original's real name, so a consumer must ENUMERATE. A superset
#: is free; one too few permanently orphans the only class that cannot be recomputed. `wav` is a legacy
#: mislabelled name still holding real m4a/webm bytes — mirrors core's KNOWN_AUDIO_EXTS.
KNOWN_AUDIO_EXTS: tuple[str, ...] = ("webm", "opus", "m4a", "mp4", "mp3", "wav")


def audio_key(media_id: str, ext: str = "wav") -> str:
    """Raw original audio. The one unrecoverable asset — never regenerable from anything else."""
    return f"audio/{media_id}.{ext.lstrip('.')}"


def candidate_audio_refs(media_id: str) -> tuple[str, ...]:
    """Every ref the retained original could live at, newest first, de-duplicated."""
    seen: dict[str, None] = {}
    for ext in KNOWN_AUDIO_EXTS:
        seen.setdefault(audio_key(media_id, ext), None)
    return tuple(seen)


# ── stems ────────────────────────────────────────────────────────────────────────────────────────

#: Core's default publish format, and lossless for a reason that is about SYNC rather than quality: a
#: lossy container with encoder pre-roll (AAC-in-m4a priming samples) shifts the vocals relative to the
#: instrumental, and the two must stay sample-aligned. Core announces the live value at handshake; this is
#: only the fallback for a worker that was told nothing.
INSTRUMENTAL_EXT = "flac"
VOCALS_EXT = "flac"
GUIDE_MIX_EXT = "flac"

#: Newest first. A row's on-disk ext depends on the publish format AT THE TIME it was processed, so a
#: cleanup or existence check that assumes one ext silently misses older files. Mirrors core's
#: KNOWN_VOCALS_EXTS.
KNOWN_STEM_EXTS: tuple[str, ...] = ("flac", "m4a", "wav")


def instrumental_key(media_id: str, ext: str = INSTRUMENTAL_EXT) -> str:
    """What actually PLAYS. The one stem whose fidelity is user-facing."""
    return f"derived/stems/{media_id}-instrumental.{ext.lstrip('.')}"


def vocals_key(media_id: str, ext: str = VOCALS_EXT) -> str:
    """Reference vocals — used for alignment and for the guide mix, not normally played."""
    return f"derived/stems/{media_id}-vocals.{ext.lstrip('.')}"


def guide_mix_key(media_id: str, ext: str = GUIDE_MIX_EXT) -> str:
    """Both stems in ONE 4-channel file (0/1 instrumental, 2/3 vocals).

    One file rather than two so drift is UNREPRESENTABLE rather than merely governed — there is no second
    file that could start at a different sample. `-guidemix`, not `-mix`: nothing here is summed.
    """
    return f"derived/stems/{media_id}-guidemix.{ext.lstrip('.')}"


def sibling_vocals_ref(instrumental_ref: str) -> str:
    """The vocals ref beside an instrumental one. Returns the input unchanged when it carries no marker."""
    return instrumental_ref.replace("-instrumental.", "-vocals.")


def legacy_vocals_refs(instrumental_ref: str) -> tuple[str, ...]:
    """The instrumental's sibling at EVERY known stem ext, for a row that stored no vocals ref.

    Empty when the ref carries no `-instrumental.` marker, which is how a caller tells "no sibling is
    possible" from "the sibling is one of these".
    """
    sibling = sibling_vocals_ref(instrumental_ref)
    if sibling == instrumental_ref:
        return ()
    stem = sibling.rsplit(".", 1)[0] + "."
    return tuple(stem + ext for ext in KNOWN_STEM_EXTS)


# ── lyrics ───────────────────────────────────────────────────────────────────────────────────────


def lyrics_key(media_id: str) -> str:
    """The CANONICAL timed-lyrics document — what `artifacts.lyrics.uri` points at."""
    return f"derived/lyrics/{media_id}.json"


def lyrics_candidate_key(media_id: str, label: str, timing: str) -> str:
    """One CANDIDATE document, per text source and timing mode.

    Core treats `candidates[].ref` as OPAQUE — it stores and serves it without deriving it — so this shape
    is the worker's to choose. It is still centralised here because the retention sweep has to be able to
    enumerate what a media owns, and a key invented at its call site cannot be enumerated.

    `:` is replaced because a label is `asr:vocals`-shaped and a colon is not safe in every object-store
    key or on every filesystem.
    """
    return f"derived/lyrics/{media_id}-{label.replace(':', '-')}-{timing}.json"


def manual_lyrics_key(media_id: str) -> str:
    """Where PASTED lyrics are published: core's `manualLyricsRef` (`core/src/lib/server/jobs/process.ts`).

    Core MINTS this ref when a person pastes lyrics (`requestLyricsReselect`), pins it as the media's
    `lyricsOverrideRef` and sends it as the align job's `pinnedRef`; the worker writes the re-timed paste
    under exactly this key, so core's merge overwrites the pinned candidate instead of adding a rival. It
    is the (manual, word) candidate key by construction, and both sides pin the literal
    (`tests/test_job_params.py`; core's `lyrics-paste-carries-pasted-text.test.ts`).
    """
    return lyrics_candidate_key(media_id, "manual", "word")


# ── raw captions: evidence, not candidates ───────────────────────────────────────────────────────

#: STRUCTURAL as a directory segment: yt-dlp names both tracks identically, so only the segment
#: distinguishes an uploader CANDIDATE from a machine BASELINE.
CAPTION_KINDS: tuple[str, ...] = ("captions", "auto-captions")

#: Not stored on the media row (debugging evidence rather than a candidate), so retention enumerates the
#: whole matrix instead of reading a ref.
KNOWN_CAPTION_EXTS: tuple[str, ...] = ("vtt", "srt")


def raw_caption_key(media_id: str, kind: str, ext: str = "vtt") -> str:
    """The caption track exactly as fetched, retained for diagnosing the parser."""
    return f"derived/captions/{kind}/{media_id}.captions.{ext.lstrip('.')}"


# ── meta ─────────────────────────────────────────────────────────────────────────────────────────


def meta_key(media_id: str) -> str:
    """The sidecar record. AUTHORITATIVE — the library rebuilds from these, not from the database."""
    return f"meta/{media_id}.json"


# ── classes ──────────────────────────────────────────────────────────────────────────────────────

#: The storage classes, split by REPLACEABILITY. A key's first segment names its class, which is what lets
#: each sit on its own filesystem: `audio/` is what to back up, `derived/` is safe to delete and
#: recomputable, `meta/` is the authoritative library, `work/` is transient job scratch.
CLASSES: tuple[str, ...] = ("audio", "derived", "meta", "work")


def class_of(ref: str) -> str:
    """The storage class a key names, or `root` for one that names none.

    Mirrors core's `classOf`. A class dir may point OUTSIDE the media root, so a key's prefix cannot simply
    be joined onto that root — resolution has to go through the class first.
    """
    head = ref.lstrip("/").split("/", 1)[0]
    return head if head in CLASSES else "root"
