"""The worker reads ENCORE_WORKER_TOKEN exactly as core does (core/tests/unit/server/secret-text.test.ts has
the same cases), so one pasted token never 401s between them."""

from encore_worker.host.config import Config, clean_token

BOM = chr(0xFEFF)
ZWSP = chr(0x200B)

# (raw, cleaned): the same table as the core test.
CASES = [
    (f"{BOM}s3cret", "s3cret"),
    (f"s3{ZWSP}cret", "s3cret"),
    ("  s3cret\t\n", "s3cret"),
    (" s3cret ", "s3cret"),
    ("\x1cs3cret\x85", "s3cret"),
    ("s3 cr&t=/", "s3 cr&t=/"),
    (f"{ZWSP}{BOM} ", ""),
]


def test_clean_token_matches_core() -> None:
    for raw, cleaned in CASES:
        assert clean_token(raw) == cleaned, repr(raw)


def test_config_cleans_the_worker_token() -> None:
    assert Config.from_env({"ENCORE_WORKER_TOKEN": f"{BOM}s3cret{ZWSP}"}).worker_token == "s3cret"
    assert Config.from_env({"ENCORE_WORKER_TOKEN": ZWSP}).worker_token is None
