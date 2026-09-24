"""@DBOS.step definitions: the only layer allowed to touch the world.

A step is a THIN shell - resolve an adapter, call a domain function, return a record. The logic lives
in domain/, so it stays testable without DBOS, an event loop, or a model.

CONTRACT: arguments and return values must be JSON-serializable, because DBOS checkpoints them. Return
refs and paths into the media directory, never bytes, tensors, or open handles.
"""
