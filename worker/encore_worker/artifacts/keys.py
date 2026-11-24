"""Store KEYS — a byte-for-byte mirror of core's `core/src/lib/server/media/paths.ts`.

Pure string templates: no I/O, no env, no config. `local.py` turns a key into a path and is the only thing
that knows where a class root lives. Why this is a mirror and not a derivation, why extensions are parameters
rather than constants, and what each key shape here is deciding: docs/arch/05-worker.md §4.
"""

from __future__ import annotations

#: Newest-served first; mirrors core's `KNOWN_AUDIO_EXTS`. A consumer must ENUMERATE these — the reason, and
#: why `wav` is in the list, are in docs/arch/05-worker.md §4.
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


#: Core's default publish format, lossless for a SYNC reason (docs/arch/05-worker.md §4). Core announces the
#: live value at handshake; this is only the fallback for a worker that was told nothing.
INSTRUMENTAL_EXT = "flac"
VOCALS_EXT = "flac"
GUIDE_MIX_EXT = "flac"

#: Newest first; mirrors core's `KNOWN_VOCALS_EXTS`. A row's on-disk ext is whichever format was live when it
#: was processed, so enumerating is the only safe check (docs/arch/05-worker.md §4).
KNOWN_STEM_EXTS: tuple[str, ...] = ("flac", "m4a", "wav")


def instrumental_key(media_id: str, ext: str = INSTRUMENTAL_EXT) -> str:
    """What actually PLAYS. The one stem whose fidelity is user-facing."""
    return f"derived/stems/{media_id}-instrumental.{ext.lstrip('.')}"


def vocals_key(media_id: str, ext: str = VOCALS_EXT) -> str:
    """Reference vocals — used for alignment and for the guide mix, not normally played."""
    return f"derived/stems/{media_id}-vocals.{ext.lstrip('.')}"


def guide_mix_key(media_id: str, ext: str = GUIDE_MIX_EXT) -> str:
    """Both stems in ONE 4-channel file (0/1 instrumental, 2/3 vocals); docs/arch/05-worker.md §4."""
    return f"derived/stems/{media_id}-guidemix.{ext.lstrip('.')}"


def sibling_vocals_ref(instrumental_ref: str) -> str:
    """The vocals ref beside an instrumental one. Returns the input unchanged when it carries no marker."""
    return instrumental_ref.replace("-instrumental.", "-vocals.")


def legacy_vocals_refs(instrumental_ref: str) -> tuple[str, ...]:
    """The instrumental's sibling at EVERY known stem ext, for a row that stored no vocals ref.

    Empty when the ref carries no `-instrumental.` marker: "no sibling is possible", not "none of these".
    """
    sibling = sibling_vocals_ref(instrumental_ref)
    if sibling == instrumental_ref:
        return ()
    stem = sibling.rsplit(".", 1)[0] + "."
    return tuple(stem + ext for ext in KNOWN_STEM_EXTS)


def lyrics_key(media_id: str) -> str:
    """The CANONICAL timed-lyrics document — what `artifacts.lyrics.uri` points at."""
    return f"derived/lyrics/{media_id}.json"


def lyrics_candidate_key(media_id: str, label: str, timing: str) -> str:
    """One CANDIDATE document, per text source and timing mode; docs/arch/05-worker.md §4."""
    return f"derived/lyrics/{media_id}-{label.replace(':', '-')}-{timing}.json"


def manual_lyrics_key(media_id: str) -> str:
    """Where a paste sent with no `pinnedRef` is published. Core always sends one (`editLyricsRef`, a new
    name per fix), so this is only the fallback (docs/arch/05-worker.md §4)."""
    return lyrics_candidate_key(media_id, "manual", "word")


#: STRUCTURAL as a directory segment, yt-dlp naming both tracks identically (docs/arch/05-worker.md §4).
CAPTION_KINDS: tuple[str, ...] = ("captions", "auto-captions")

#: Not stored on the media row — evidence, not a candidate — so retention enumerates the whole matrix.
KNOWN_CAPTION_EXTS: tuple[str, ...] = ("vtt", "srt")


def raw_caption_key(media_id: str, kind: str, ext: str = "vtt") -> str:
    """The caption track exactly as fetched, retained for diagnosing the parser."""
    return f"derived/captions/{kind}/{media_id}.captions.{ext.lstrip('.')}"


def meta_key(media_id: str) -> str:
    """The sidecar record. AUTHORITATIVE — the library rebuilds from these, not from the database."""
    return f"meta/{media_id}.json"


#: The storage classes, split by REPLACEABILITY and named by a key's first segment: `audio/` is what to back
#: up, `derived/` is recomputable, `meta/` is the authoritative library, `work/` is transient job scratch.
CLASSES: tuple[str, ...] = ("audio", "derived", "meta", "work")


def class_of(ref: str) -> str:
    """The storage class a key names, or `root` for one that names none. Mirrors core's `classOf`."""
    head = ref.lstrip("/").split("/", 1)[0]
    return head if head in CLASSES else "root"
