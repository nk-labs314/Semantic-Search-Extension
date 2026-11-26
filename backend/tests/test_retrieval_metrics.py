from __future__ import annotations

import statistics
import unittest
from typing import Iterable, Sequence


def recall_at_k(retrieved: Sequence[str], relevant: set[str], k: int) -> float:
    """Return the fraction of relevant items found in the first k results."""
    if not relevant:
        raise ValueError("relevant must contain at least one item")
    if k < 1:
        raise ValueError("k must be at least 1")
    return len(set(retrieved[:k]) & relevant) / len(relevant)


def median_latency_ms(samples_ms: Iterable[float]) -> float:
    """Return the median latency, rejecting an empty measurement set."""
    samples = list(samples_ms)
    if not samples:
        raise ValueError("at least one latency sample is required")
    return statistics.median(samples)


class RetrievalMetricTests(unittest.TestCase):
    def test_recall_at_k_counts_relevant_results_only(self) -> None:
        self.assertEqual(recall_at_k(["a", "x", "b"], {"a", "b"}, 2), 0.5)

    def test_recall_at_k_caps_duplicate_hits(self) -> None:
        self.assertEqual(recall_at_k(["a", "a", "b"], {"a", "b"}, 3), 1.0)

    def test_median_latency_ms(self) -> None:
        self.assertEqual(median_latency_ms([4.0, 1.0, 3.0, 2.0]), 2.5)

    def test_metrics_reject_invalid_inputs(self) -> None:
        with self.assertRaises(ValueError):
            recall_at_k(["a"], set(), 1)
        with self.assertRaises(ValueError):
            recall_at_k(["a"], {"a"}, 0)
        with self.assertRaises(ValueError):
            median_latency_ms([])


