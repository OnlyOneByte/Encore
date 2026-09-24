"""The logic, as pure functions over plain data.

MUST NOT import dbos, asyncio, or torch - enforced by a test over the import graph. This is the layer
that ports over from worker/ essentially unchanged, and the reason the suite runs with no ML installed:
grading, timing validation, presplit, LRC placement and analysis are all decidable from data.
"""
