from concurrent.futures import ThreadPoolExecutor as ThreadPoolExecutor
from typing import Any

import torch

class TensorChunk:
    tensor: torch.Tensor
    offset: int
    length: int
    def __init__(
        self, tensor: torch.Tensor | TensorChunk, offset: int = 0, length: int | None = None
    ) -> None: ...

def apply_model(
    model: Any,
    mix: torch.Tensor | TensorChunk,
    shifts: int = 1,
    split: bool = True,
    overlap: float = 0.25,
    transition_power: float = 1.0,
    progress: bool = False,
    device: Any = None,
    num_workers: int = 0,
    segment: float | None = None,
    pool: Any = None,
) -> torch.Tensor: ...
