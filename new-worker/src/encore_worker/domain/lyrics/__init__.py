"""Choosing and checking WORDS: candidate grading, timing validation, presplit, LRC placement.

Where the two headline defects get fixed:

  * selection must never hand back an empty publish set while any timeable text remains. The old
    worker returned `baselines[:1]`, which is `[]` when no baseline ran.
  * `accept(report) -> Verdict` is a PURE decision over a TimingReport, which is what makes
    retry-with-different-parameters a table-driven unit test rather than an integration test.
"""
