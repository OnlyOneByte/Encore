"""Guard: ARCHITECTURE.md's capability-routing prose may only name `stems*` tokens that `probe_all`
can actually ADVERTISE.

The doc twice named tokens the probe cannot emit (#299): `stems:ensemble` (hard-coded unavailable by
#118's own fix) and `stems:mlx` (never a token -- capabilities key on the ENGINE, not the backend).
Both are the exact "the doc conforms to code that does something else" class the generated-region
freshness test (test_worker_layers.py) exists to prevent, but this prose sits ~90 lines above the
generated markers and is hand-maintained, so nothing caught the drift.

This test reads the hand-maintained capability-routing enumeration and cross-checks it against what
`probe_all` reports available on a maximal box -- the same in-memory simulation the issue used
(every CLI present, whisperx importable). Reverting the doc to re-add either phantom reds it.
"""
from __future__ import annotations

import re

from src import capabilities
from src.docgen import ARCHITECTURE


def _maximal_box_available_tokens(monkeypatch) -> set[str]:
    """Tokens `probe_all` reports available=True on a box where every executor is present.

    `_either` uses `capabilities.shutil.which` and `capabilities._module_available`; `align` uses
    `capabilities._module_available` directly. Patching both to succeed is the maximal box, in-process
    and read-only -- the same harness the issue measured with.
    """
    monkeypatch.setattr(capabilities.shutil, "which", lambda _bin: "/usr/bin/present")
    monkeypatch.setattr(capabilities, "_module_available", lambda _mod: True)
    return {p.token for p in capabilities.probe_all() if p.available}


def _advertised_enumeration() -> str:
    """The arrow-enumeration that says which token each probe EMITS: 'demucs -> `stems`, ...'.

    Scoped to the run from 'Each token is backed by a probe' up to the em-dash that closes the list
    ('-- and the evidence is logged either way'), so surrounding prose -- including a sentence that
    explicitly says a token is NOT advertised -- is deliberately outside the capture. What is inside
    is only the positive 'this probe advertises this token' claims.
    """
    text = ARCHITECTURE.read_text(encoding="utf-8")
    m = re.search(r"Each token is backed by a probe(.*?)\u2014\s*and the evidence is logged", text, re.DOTALL)
    assert m, "capability-routing enumeration not found in ARCHITECTURE.md -- this guard has stopped guarding"
    return m.group(1)


def test_doc_only_advertises_stems_tokens_the_probe_can_emit(monkeypatch):
    available = _maximal_box_available_tokens(monkeypatch)
    # Sanity: the maximal box really does prove the four real tokens, so a bug that made probe_all
    # refuse everything would fail HERE rather than letting this guard pass vacuously.
    assert {"fetch:ytdlp", "stems", "stems:roformer", "align"} <= available
    # And the phantoms genuinely are NOT advertised -- the fact the doc's enumeration must not contradict.
    assert "stems:ensemble" not in available
    assert "stems:mlx" not in available

    enum = _advertised_enumeration()
    named = set(re.findall(r"`(stems(?::[a-z]+)?)`", enum))
    assert "stems" in named, "no stems token found in the advertised enumeration -- anchor drifted"
    unbacked = named - available
    assert not unbacked, (
        f"ARCHITECTURE.md's capability-routing enumeration advertises {sorted(unbacked)}, which "
        f"probe_all does not emit as available. probe_all advertises "
        f"{sorted(t for t in available if t.startswith('stems'))}."
    )


def test_backend_never_advertised_as_a_capability_token_in_the_routing_prose():
    """`:474` used `stems:mlx` as a token a worker would ADVERTISE, contradicting `:468`
    ('backend ... never user-visible'). A capability keys on the ENGINE, so no `stems:<backend>`
    token may be presented as advertised/extended. Matches the AFFIRMATIVE over-promise only -- a
    `stems:<backend>` token immediately preceded by 'not ' is the corrected denial and does not
    self-trip. Reverting `:474` to '(`stems:roformer`, `stems:mlx`)' reds this."""
    text = ARCHITECTURE.read_text(encoding="utf-8")
    backends = ["mlx", "torch", "openvino", "xpu"]
    offenders = []
    for be in backends:
        for m in re.finditer(r"`stems:%s`" % be, text):
            preceding = text[max(0, m.start() - 8):m.start()]
            # The corrected prose writes 'not `stems:mlx`' -- a denial, not an advertisement.
            negated = preceding.rstrip().endswith("not")
            if not negated:
                offenders.append(f"stems:{be}")
    assert not offenders, (
        f"ARCHITECTURE.md presents backend(s) as advertised capability tokens {sorted(set(offenders))} "
        f"-- a capability keys on the engine, not the backend it runs through (see 'never user-visible')."
    )
