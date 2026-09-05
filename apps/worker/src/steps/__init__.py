"""Steps: the named units of work a plan is made of.

Each module here holds the steps for one part of a job, and each step is THIN — it orchestrates a domain
package and yields progress. The knowledge lives in `lyrics/`, `separation/`, `analysis/`, `acquisition/`
and `metadata/`; a step decides when that knowledge runs and what it writes to the context.

This layer may import a domain and the runtime. A domain may import neither, which is the dependency rule
in `docs/archive/specs/SPEC-worker-pipeline.md` §3 and is enforced by tests/test_worker_layers.py.
"""
