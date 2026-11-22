"""The model zoo: a catalogue read from the library rather than hand-maintained, and what it must refuse.

No model is RUN here — a zoo checkpoint is a 100-400 MB download and a minute of inference. What is asserted
is the catalogue's shape and, more importantly, the filter: the zoo contains de-reverb, de-noise, drum
separation and bass isolation models, and handing one of those to a karaoke pipeline produces a plausible
file that is not a backing track.
"""

from __future__ import annotations

import pytest

from encore_worker.adapters import zoo
from tests import zoo_fixture
from tests.zoo_fixture import catalogue_or_skip, needs_zoo

# ── the filter, which is the safety-relevant half ────────────────────────────────────────────────


def test_a_vocals_and_backing_pair_is_offered_with_its_roles_declared() -> None:
    assert zoo._role_source(("instrumental", "vocals")) == "declared"
    assert zoo._role_source(("vocals", "instrumental")) == "declared"


def test_a_model_declaring_nothing_is_offered_as_unknown_rather_than_dropped() -> None:
    """62 of the 169 entries declare no stems, and dropping them was a real mistake — it hid
    `bs-roformer-vocals-by-gabox`, which carries the HIGHEST published instrumental SDR in the whole
    catalogue (17.21 dB), and `bs-roformer-instrumental-resurrection-by-unwa`, the one roformer this project
    has measured itself.

    They are offered because runtime role detection does not need the declaration. That is the entire point
    of measuring: an undeclared model is not an unsafe model, it is an undescribed one.
    """
    assert zoo._role_source(()) == "unknown"


@pytest.mark.parametrize(
    "stems",
    [
        ("noreverb", "reverb"),  # BS-Roformer-De-Reverb
        ("dry", "no dry"),  # UVR-De-Reverb
        ("echo", "no echo"),  # UVR-De-Echo-Aggressive
        ("no noise", "noise"),  # UVR-DeNoise
        ("drums", "no drums"),  # kuielab_a_drums
        ("bass", "no bass"),  # kuielab_a_bass
        ("no woodwinds", "woodwinds"),  # 17_HP-Wind_Inst-UVR
        ("aspiration", "other"),
    ],
)
def test_models_that_cannot_make_a_karaoke_master_are_refused(stems: tuple[str, ...]) -> None:
    """THE FILTER THAT MATTERS. A de-reverb model emits a slightly drier copy of the whole song. Run it as a
    separator and you publish that as the instrumental — full vocals included — and nothing downstream can
    tell: it is the right length, it is not silent, and the guide mix builds. Role detection would not save
    this either, because both outputs carry the same bass.
    """
    assert zoo._role_source(stems) is None


def test_the_four_source_demucs_decomposition_is_left_to_the_native_path() -> None:
    """Excluded on purpose rather than by oversight: its instrumental must be SUMMED from three sources,
    which `separate.instrumental_sources` already does, and `htdemucs_ft`/`htdemucs_6s` are reachable there.
    Two routes to one set of weights is a way for two answers to disagree."""
    assert zoo._role_source(("vocals", "drums", "bass", "other")) is None


# ── tokens are forever ───────────────────────────────────────────────────────────────────────────


def test_a_token_survives_punctuation_changes_upstream() -> None:
    """The token lands in `job_attempts.model` permanently, so it must not change when upstream edits a
    label's spacing or colons. Both of these are the same model named two ways."""
    assert zoo.slugify("MDX-Net Model: UVR-MDX-NET Inst HQ 1") == zoo.slugify(
        "MDX-Net Model:  UVR-MDX-NET  Inst  HQ  1"
    )


def test_a_token_carries_nothing_that_needs_escaping() -> None:
    """It travels in a websocket frame and a SQL row, and it names a scratch directory."""
    token = zoo.slugify("Roformer Model: BS-Roformer | ViperX 1297 (by @someone)")
    assert token and all(ch.isalnum() or ch == "-" for ch in token)
    assert not token.startswith("-") and not token.endswith("-")


# ── the catalogue itself ─────────────────────────────────────────────────────────────────────────


def test_an_absent_extra_yields_an_empty_catalogue_rather_than_an_import_error() -> None:
    """`host.capabilities` decides whether to advertise the zoo. An import error here would turn a
    capability question into a crashed startup on every box without the extra."""
    assert isinstance(zoo.catalogue(), tuple)


def test_the_upstream_listing_is_probed_once_per_process(monkeypatch: pytest.MonkeyPatch) -> None:
    """`catalogue_or_skip` asks it on every call where the catalogue is empty — 8 call-through sites in this
    suite — and the probe builds a `Separator`, which is exactly what `zoo.catalogue` is cached to pay once
    (docs/arch/05-worker.md §2.3).

    The probe is faked here rather than run: a cold one is minutes of wall clock.
    """
    import sys
    import types

    built: list[str] = []

    class Fake:
        def __init__(self, **_options: object) -> None:
            built.append("separator")

        def list_supported_model_files(self) -> dict[str, object]:
            return {"model": {}}

    separator = types.ModuleType("audio_separator.separator")
    separator.Separator = Fake  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "audio_separator", types.ModuleType("audio_separator"))
    monkeypatch.setitem(sys.modules, "audio_separator.separator", separator)

    zoo_fixture.upstream_listing_is_readable.cache_clear()
    try:
        assert zoo_fixture.upstream_listing_is_readable() is True
        assert zoo_fixture.upstream_listing_is_readable() is True
    finally:
        zoo_fixture.upstream_listing_is_readable.cache_clear()
    assert built == ["separator"], f"the listing was probed {len(built)} times in one process"


def test_a_catalogue_that_was_read_and_is_empty_fails_where_an_unreadable_one_skips(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """THE DISTINCTION THE HELPER EXISTS FOR, and the reason a blanket skip was not acceptable: `catalogue()`
    answers `()` both when upstream's listing could not be fetched — the suite blocks the socket and the
    library caches it under `/tmp` — and when the filter rejected every entry, which is the defect the tests
    below are for. Only the first is an environment fact.

    THE POSITIVE HALF TURNS A SKIP INTO A FAILURE. Called bare, a reversion to the blanket skip this helper
    replaced raises `skip.Exception` out of the test body and pytest reports the GUARD as skipped — green,
    and reporting the regression as an environment fact."""
    monkeypatch.setattr(zoo, "catalogue", lambda: ())
    monkeypatch.setattr(zoo_fixture, "upstream_listing_is_readable", lambda: True)
    try:
        assert zoo_fixture.catalogue_or_skip() == ()
    except pytest.skip.Exception as skipped:
        pytest.fail(f"a listing that WAS read must not skip: {skipped}")

    monkeypatch.setattr(zoo_fixture, "upstream_listing_is_readable", lambda: False)
    with pytest.raises(pytest.skip.Exception, match="cannot be read here"):
        zoo_fixture.catalogue_or_skip()


@needs_zoo
def test_the_catalogue_is_not_empty_and_every_entry_can_be_looked_up() -> None:
    models = catalogue_or_skip()
    assert len(models) > 50, f"only {len(models)} usable models; the filter may have over-tightened"
    for model in models[:20]:
        assert zoo.by_token(model.token) is model


@needs_zoo
def test_tokens_are_unique() -> None:
    """Two upstream labels can slug to one token. A duplicate would make `by_token` return whichever came
    first, silently separating with the wrong model — the same failure the registry's uniqueness test
    guards."""
    tokens = [m.token for m in catalogue_or_skip()]
    assert len(tokens) == len(set(tokens))


@needs_zoo
def test_the_catalogue_is_ranked_so_the_list_means_something_unmeasured() -> None:
    """An operator browsing 130+ models needs the order to carry information before they have run any of
    them. Best published instrumental SDR first, unscored last."""
    scored = [
        m.upstream_instrumental_sdr for m in catalogue_or_skip() if m.upstream_instrumental_sdr is not None
    ]
    assert scored == sorted(scored, reverse=True)


@needs_zoo
def test_upstream_scores_are_never_labelled_as_our_own_measurement() -> None:
    """THE PROVENANCE RULE, and this repo learned it the hard way: an `htdemucs` cost of 0.29x once sat in
    the registry labelled `provenance="measured"` having been copied from core's GPU contract.

    These scores are real but they are someone else's — different tracks, and museval BSS-eval SDR rather
    than the plain SDR `docs/benchmarks/stem-separation` reports. So the word `measured` must not appear,
    and the incomparability must be stated where a reader will see it.
    """
    for model in catalogue_or_skip():
        if model.upstream_instrumental_sdr is None:
            continue
        assert "upstream" in model.provenance
        assert "measured" not in model.provenance
        assert "NOT comparable" in model.provenance


@needs_zoo
def test_the_models_this_project_has_measured_are_present() -> None:
    """Consolidating onto audio-separator must not lose the checkpoint we benchmarked ourselves at 17.37 dB
    instrumental SI-SDR. It is in the zoo — under `unknown` roles, which is why an early version of the
    filter appeared to show zero overlap between the two libraries."""
    models = catalogue_or_skip()
    wanted = "roformer-model-bs-roformer-instrumental-resurrection-by-unwa"
    assert any(m.token == wanted for m in models), f"{wanted} is not among the {len(models)} offered"


@needs_zoo
def test_no_offered_model_is_a_four_stem_one() -> None:
    """The exclusion has to hold on the real catalogue, not just on the predicate: a Demucs entry reaching a
    two-stem publication path would have its instrumental read from one of four files."""
    four = {"vocals", "drums", "bass", "other"}
    for model in catalogue_or_skip():
        assert not four.issubset({s.lower() for s in model.stems}), model.token
