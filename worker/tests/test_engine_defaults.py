"""The engine seam: shared defaults in one place, and the two overrides that are real.

`derive_argvs` returned `[]` in three of the four engines and `input_wav` returned the same
`os.path.join(work, "input.wav")` in three of the four — because `SeparatorEngine` is a `Protocol` whose
`...` bodies cannot hand a default to an implementer. `SeparatorDefaults` now owns both.

These tests exist to keep that from silently regrowing, and to pin the split that makes it work: the
Protocol stays the STRUCTURAL type (so a test fake needs no base class) while the defaults are ordinary
inherited code.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.separation.engines import (  # noqa: E402
    AudioSepEngine,
    DemucsEngine,
    MlxDemucsEngine,
    RoformerEngine,
    SeparatorDefaults,
    SeparatorEngine,
    engine_for,
)

#: Every engine that exists. A fifth one added without a decision about the defaults shows up here.
ALL = (DemucsEngine, MlxDemucsEngine, RoformerEngine, AudioSepEngine)


def test_every_engine_inherits_the_defaults() -> None:
    """The point of the base class. An engine that opts out has to say so in a diff."""
    for cls in ALL:
        assert issubclass(cls, SeparatorDefaults), f"{cls.__name__} no longer inherits the defaults"


def test_the_three_file_based_engines_share_ONE_input_wav_implementation() -> None:
    """Not just equal answers — literally the same function object, so they cannot drift apart."""
    for cls in (DemucsEngine, MlxDemucsEngine, AudioSepEngine):
        assert cls.input_wav is SeparatorDefaults.input_wav, (
            f"{cls.__name__} has its own input_wav again; if that is deliberate the override needs a "
            f"reason at the site, like RoformerEngine's"
        )


def test_the_three_two_stem_engines_share_ONE_derive_argvs_implementation() -> None:
    for cls in (DemucsEngine, RoformerEngine, AudioSepEngine):
        assert cls.derive_argvs is SeparatorDefaults.derive_argvs, f"{cls.__name__} re-declared the no-op"


def test_roformer_overrides_input_wav_because_its_CLI_takes_a_DIRECTORY(tmp_path) -> None:
    """The real override. bs-roformer-infer separates every WAV in --input_folder, so its input cannot
    share the scratch dir that also holds its output — a single input.wav there would be re-separated."""
    assert RoformerEngine.input_wav is not SeparatorDefaults.input_wav
    got = engine_for("roformer").input_wav(str(tmp_path))
    assert got == os.path.join(str(tmp_path), "roformer_in", "input.wav")
    assert os.path.isdir(os.path.dirname(got)), "the dedicated dir must be created, not just named"


def test_mlx_overrides_derive_argvs_because_demucs_mlx_has_no_two_stems_flag() -> None:
    """The other real override: one ffmpeg mix-minus pass sums the non-vocal stems into no_vocals.wav."""
    assert MlxDemucsEngine.derive_argvs is not SeparatorDefaults.derive_argvs
    eng = engine_for("demucs", backend="mlx")
    argvs = eng.derive_argvs("/w/input.wav", "/o", eng.resolve_model({}))
    assert len(argvs) == 1, "exactly one derived command"
    assert argvs[0][0] == "ffmpeg" and "amix=inputs=3:normalize=0" in argvs[0]
    assert argvs[0][-1].endswith("no_vocals.wav")


def test_the_defaults_answer_what_they_replaced(tmp_path) -> None:
    """Parity, stated as a test: the exact values the three engines used to return themselves.

    Verified against the pre-refactor code as well — every engine's `input_wav`, `derive_argvs`,
    `stem_format`, `id` and `backend` were dumped before and after and compared byte for byte.
    """
    # All three file-based engines: the shared input path.
    for name, kwargs in (("demucs", {}), ("demucs", {"backend": "mlx"}), ("audiosep", {})):
        eng = engine_for(name, **kwargs)
        assert eng.input_wav(str(tmp_path)) == os.path.join(str(tmp_path), "input.wav")

    # The three two-stem engines: nothing derived. MLX is excluded because it genuinely derives one pass.
    for name in ("demucs", "roformer", "audiosep"):
        eng = engine_for(name)
        assert eng.derive_argvs("/w/input.wav", "/o", eng.resolve_model({})) == []


def test_a_fake_satisfies_the_protocol_without_inheriting_anything() -> None:
    """WHY the Protocol and the defaults are separate classes.

    The suite passes small fakes to `Separate` all over (test_demucs.py, test_roformer.py, …). Structural
    typing is what lets them do that. Fold the defaults INTO the type as an ABC and every fake has to
    inherit and implement members it does not care about — the suite starts describing the framework
    instead of the behaviour.
    """

    class Fake:
        id = "fake"
        backend = "fake"
        stem_format = "wav"

        def resolve_model(self, params: dict) -> str:
            return "m"

        def input_wav(self, work: str) -> str:
            return "/in.wav"

        def separate_argv(self, input_wav: str, out_dir: str, model: str) -> list[str]:
            return ["true"]

        def parse_progress(self, line: str) -> int | None:
            return None

        def find_outputs(self, out_dir: str, model: str) -> dict[str, str | None]:
            return {}

        def derive_argvs(self, input_wav: str, out_dir: str, model: str) -> list[list[str]]:
            return []

    engine: SeparatorEngine = Fake()  # a type error here would mean the seam grew an inheritance demand
    assert not isinstance(engine, SeparatorDefaults)
    assert engine.derive_argvs("", "", "") == []


def test_a_new_engine_gets_both_defaults_for_free() -> None:
    """The payoff: a fifth engine writes only what is genuinely its own."""

    class Fifth(SeparatorDefaults):
        id = "fifth"
        backend = "fifth"

    assert Fifth().input_wav("/w") == os.path.join("/w", "input.wav")
    assert Fifth().derive_argvs("/w/input.wav", "/o", "m") == []
