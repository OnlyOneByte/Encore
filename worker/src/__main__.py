"""The worker's entry point, so the tree says where to start.

`python -m src` runs the same thing `python -m src.dial_home` always has — this file exists because
nothing in a directory of ten modules told a reader which one was the door. The Dockerfile's
`CMD ["python", "-m", "src.dial_home"]` and the README's native-run command both keep working; this is an
addition, not a replacement, and deliberately so: changing the container's entry command to gain a
shorter spelling would be churn in the one place a mistake stops the worker from starting at all.

Nothing lives here but the call. The protocol loop is `dial_home._run_forever`, what it builds is
`bootstrap._build_processor`, and both are worth reading before this file.
"""

from __future__ import annotations

import asyncio

from .dial_home import _run_forever

if __name__ == "__main__":
    asyncio.run(_run_forever())
