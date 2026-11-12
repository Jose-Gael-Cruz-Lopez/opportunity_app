"""Line matching between two OCR engines.

Lines are paired by a minimum-cost assignment (Hungarian algorithm) on
1 - IoU of their boxes, then pairs below the IoU threshold are released.
An optimal assignment avoids the greedy failure where one wide line steals
the partner of two narrower ones.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

from .boxes import Box, iou


def hungarian(cost: Sequence[Sequence[float]]) -> list[tuple[int, int]]:
    """Minimum-cost assignment for a rectangular matrix.

    Returns (row, col) pairs; every row is assigned when rows <= cols, and
    every column otherwise. O(n^2 m), adequate for the tens of lines on a page.
    """
    n = len(cost)
    if n == 0:
        return []
    m = len(cost[0])
    if m == 0:
        return []
    if n > m:
        transposed = [[cost[r][c] for r in range(n)] for c in range(m)]
        return [(r, c) for c, r in hungarian(transposed)]
    inf = math.inf
    u = [0.0] * (n + 1)
    v = [0.0] * (m + 1)
    p = [0] * (m + 1)  # p[j] = row assigned to column j (1-based), 0 = none
    way = [0] * (m + 1)
    for i in range(1, n + 1):
        p[0] = i
        j0 = 0
        minv = [inf] * (m + 1)
        used = [False] * (m + 1)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = inf
            j1 = 0
            for j in range(1, m + 1):
                if used[j]:
                    continue
                cur = cost[i0 - 1][j - 1] - u[i0] - v[j]
                if cur < minv[j]:
                    minv[j] = cur
                    way[j] = j0
                if minv[j] < delta:
                    delta = minv[j]
                    j1 = j
            for j in range(m + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break
    return sorted((p[j] - 1, j - 1) for j in range(1, m + 1) if p[j] != 0)


@dataclass(frozen=True)
class LineMatch:
    pairs: list[tuple[int, int]]  # (index in a, index in b)
    lone_a: list[int]
    lone_b: list[int]


def match_lines(a: Sequence[Box], b: Sequence[Box], *, min_iou: float) -> LineMatch:
    if not a or not b:
        return LineMatch([], list(range(len(a))), list(range(len(b))))
    cost = [[1.0 - iou(x, y) for y in b] for x in a]
    pairs = [(i, j) for i, j in hungarian(cost) if iou(a[i], b[j]) >= min_iou]
    used_a = {i for i, _ in pairs}
    used_b = {j for _, j in pairs}
    return LineMatch(
        pairs=pairs,
        lone_a=[i for i in range(len(a)) if i not in used_a],
        lone_b=[j for j in range(len(b)) if j not in used_b],
    )
