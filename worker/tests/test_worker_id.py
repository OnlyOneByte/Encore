"""A worker's default id is unique per machine and stable across restarts; an explicit one still wins.

Core keys a worker by its id and treats a repeated id as the same worker reconnecting (`registry.hello`
REPLACES the session). Two live workers sharing one id therefore collapse into one registry entry, commands
flip between their sockets, and when either quits the other is deregistered while still connected.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from encore_worker.host.config import Config


def _on_machine(monkeypatch: pytest.MonkeyPatch, hostname: str, mac: int) -> None:
    monkeypatch.setattr("socket.gethostname", lambda: hostname)
    monkeypatch.setattr("uuid.getnode", lambda: mac)


def test_two_machines_never_share_the_default_id(monkeypatch: pytest.MonkeyPatch) -> None:
    _on_machine(monkeypatch, "gpu-box.lan", 0x0242AC110002)
    gpu = Config.from_env({}).worker_id
    _on_machine(monkeypatch, "laptop", 0x0242AC110003)
    laptop = Config.from_env({}).worker_id
    assert gpu != laptop
    assert re.fullmatch(r"worker-[0-9a-f]{6}", gpu) and re.fullmatch(r"worker-[0-9a-f]{6}", laptop)


def test_two_machines_with_one_hostname_still_differ(monkeypatch: pytest.MonkeyPatch) -> None:
    _on_machine(monkeypatch, "MacBook-Pro", 0x0242AC110002)
    first = Config.from_env({}).worker_id
    _on_machine(monkeypatch, "MacBook-Pro", 0x0242AC110003)
    assert Config.from_env({}).worker_id != first


def test_two_workers_on_one_box_differ_by_their_durable_state(monkeypatch: pytest.MonkeyPatch) -> None:
    _on_machine(monkeypatch, "gpu-box", 0x0242AC110002)
    a = Config.from_env({"ENCORE_DBOS_DB": "/srv/a/encore-worker.sqlite"}).worker_id
    b = Config.from_env({"ENCORE_DBOS_DB": "/srv/b/encore-worker.sqlite"}).worker_id
    assert a != b


def test_the_default_id_is_stable_across_restarts(monkeypatch: pytest.MonkeyPatch) -> None:
    _on_machine(monkeypatch, "gpu-box", 0x0242AC110002)
    assert Config.from_env({}).worker_id == Config.from_env({}).worker_id
    assert re.fullmatch(r"worker-[0-9a-f]{6}", Config.from_env({}).worker_id)


def test_the_default_id_never_carries_the_hostname(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every guest sees the id on /metrics, and a hostname like `Alices-MacBook-Pro` names the owner."""
    _on_machine(monkeypatch, "Alices-MacBook-Pro.local", 0x0242AC110002)
    worker_id = Config.from_env({}).worker_id
    assert "alice" not in worker_id.lower() and "macbook" not in worker_id.lower()


def test_an_explicit_id_wins(monkeypatch: pytest.MonkeyPatch) -> None:
    _on_machine(monkeypatch, "gpu-box", 0x0242AC110002)
    assert Config.from_env({"ENCORE_WORKER_ID": " stage-left "}).worker_id == "stage-left"


def test_compose_leaves_the_id_to_the_worker() -> None:
    """A fixed fallback in compose would hand every Docker worker the same id, whatever the worker derives."""
    compose = (Path(__file__).resolve().parents[2] / "docker" / "compose.yaml").read_text()
    assert "- ENCORE_WORKER_ID=${ENCORE_WORKER_ID:-}\n" in compose
