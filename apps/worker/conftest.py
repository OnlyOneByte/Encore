"""Arm the runtime's undeclared-write guard for the whole worker suite.

`runtime/runner.STRICT_WRITES` reads `ENCORE_STRICT_STEP_WRITES` ONCE, at module import. The guard it
gates — `_assert_declared_writes` — is the enforcement that keeps `Ctx` from decaying into a shared
god-object every step writes anywhere; unarmed it is decoration. Production leaves the flag unset and
pays nothing. But the suite whose job is to prove the guard works ran with it OFF: pytest.ini has no env
section and there was no conftest, so `STRICT_WRITES` was False for every default run and the guard fired
only in the two tests that monkeypatch it to True.

Setting the env here — BEFORE any `src` import, which conftest.py collection guarantees — makes the module
constant True for the real cook plans too, so a step that writes an undeclared `ctx` key fails the suite
instead of only the two hand-armed cases. Env, not `monkeypatch`, because the value is captured at import
and a session-wide default cannot come from a per-test fixture.
"""

import os

os.environ.setdefault("ENCORE_STRICT_STEP_WRITES", "1")
