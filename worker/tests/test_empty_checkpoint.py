"""#1387: an empty or cut-short cached checkpoint counts as missing. It is fetched again when it can be,
and otherwise the worker fails naming the file and the model, never an opaque unpickling error mid-job."""

from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from encore_worker.adapters.ml import ModelUnavailable, ensure_checkpoint

URL = "https://download.pytorch.org/torchaudio/models/hubert_fairseq_large_ll60k_asr_ls960.pth"


def _good_checkpoint() -> bytes:
    """A zip archive, the shape torch.save writes."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as archive:
        archive.writestr("archive/data.pkl", b"weights")
    return out.getvalue()


class Fetch:
    def __init__(self, body: bytes | None) -> None:
        self.body = body
        self.calls: list[tuple[str, str]] = []

    def __call__(self, url: str, dst: str) -> None:
        self.calls.append((url, dst))
        if self.body is None:
            raise OSError("Temporary failure in name resolution")
        Path(dst).write_bytes(self.body)


@pytest.fixture
def cached(tmp_path: Path) -> Path:
    return tmp_path / "checkpoints" / "hubert_fairseq_large_ll60k_asr_ls960.pth"


def _put(path: Path, body: bytes) -> None:
    path.parent.mkdir(parents=True)
    path.write_bytes(body)


def test_an_empty_checkpoint_is_fetched_again(cached: Path) -> None:
    _put(cached, b"")
    fetch = Fetch(_good_checkpoint())
    ensure_checkpoint(str(cached), URL, "HUBERT_ASR_LARGE", fetch)
    assert fetch.calls == [(URL, str(cached))]
    assert zipfile.is_zipfile(cached)


def test_an_empty_checkpoint_with_no_network_names_the_file_and_the_model(cached: Path) -> None:
    _put(cached, b"")
    with pytest.raises(ModelUnavailable) as refused:
        ensure_checkpoint(str(cached), URL, "HUBERT_ASR_LARGE", Fetch(None))
    message = str(refused.value)
    assert str(cached) in message and "HUBERT_ASR_LARGE" in message
    assert "empty (0 bytes)" in message and "Delete that file" in message
    assert cached.read_bytes() == b"", "a failed fetch leaves the cache as it was"


def test_a_cut_short_checkpoint_counts_as_missing(cached: Path) -> None:
    _put(cached, _good_checkpoint()[:20])
    with pytest.raises(ModelUnavailable, match="cut short"):
        ensure_checkpoint(str(cached), URL, "HUBERT_ASR_LARGE", Fetch(None))


def test_a_fetch_that_comes_back_empty_again_still_fails_clearly(cached: Path) -> None:
    _put(cached, b"")
    with pytest.raises(ModelUnavailable, match="fresh copy is damaged too"):
        ensure_checkpoint(str(cached), URL, "HUBERT_ASR_LARGE", Fetch(b""))


@pytest.mark.parametrize(
    "body", [None, _good_checkpoint(), b"\x80\x02legacy-pickle"], ids=["absent", "good", "legacy"]
)
def test_an_absent_good_or_legacy_checkpoint_is_left_to_torch(cached: Path, body: bytes | None) -> None:
    if body is not None:
        _put(cached, body)
    fetch = Fetch(None)
    ensure_checkpoint(str(cached), URL, "HUBERT_ASR_LARGE", fetch)
    assert fetch.calls == []
