"""Everything the worker measures or is told about the BOX it runs on.

The host layer: what hardware is present (`hardware`), which separator backend that hardware can
actually run (`backends`), what the box can therefore PROVE it can do (`capabilities`), what the
operator configured (`config`), where media lives (`mediastore`), and the one shared ffmpeg argv
builder (`ffmpeg`).

These six sat in `src/` alongside the protocol loop, the plan seam and the vocabulary — sixteen
ungrouped modules, of which these were the largest single concern at 1433 lines. Grouped here so a
reader opening `src/` sees a handful of named things rather than a flat list, and so "what does this
box look like" is one directory rather than a scavenger hunt.

Nothing here imports a domain, a step, or the runtime. It is measured facts and operator intent.
"""
