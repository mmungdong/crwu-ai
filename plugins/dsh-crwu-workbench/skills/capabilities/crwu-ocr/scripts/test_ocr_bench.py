#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit tests for the maintenance benchmark (no real materials)."""
from __future__ import annotations

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ocr_bench  # noqa: E402


class BenchTest(unittest.TestCase):
    def test_silent_error_excludes_flagged_pages(self):
        index = {"sources": [{"sourceId": "s1", "pages": [{"page": 1}]}]}
        recognition = {"s1": {"pages": [{"page": 1, "conflicts": [],
                                          "keyValues": [{"label": "评估值", "value": "100"}]}]}}
        truth = {"pages": [{"page": 1, "keyValues": [{"label": "评估值", "value": "200"}]}]}
        metrics = ocr_bench.compute_metrics(index, recognition, truth)
        self.assertEqual(0.0, metrics["keyValueAccuracy"])
        self.assertEqual(1.0, metrics["silentErrorRate"])

    def test_conflict_page_is_not_silent(self):
        index = {"sources": [{"sourceId": "s1", "pages": [{"page": 1}]}]}
        recognition = {"s1": {"pages": [{"page": 1,
                                          "conflicts": [{"field": "评估值"}],
                                          "keyValues": [{"label": "评估值", "value": "100"}]}]}}
        truth = {"pages": [{"page": 1, "keyValues": [{"label": "评估值", "value": "200"}]}]}
        metrics = ocr_bench.compute_metrics(index, recognition, truth)
        self.assertEqual(0.0, metrics["silentErrorRate"])

    def test_table_cell_accuracy_counts_missing_cells_as_wrong(self):
        index = {"sources": [{"sourceId": "s1", "pages": [{"page": 1}]}]}
        truth = {"pages": [{"page": 1, "tables": [{"rows": [["a", "b"], ["1", "2"]]}]}]}
        recognition = {"s1": {"pages": [{"page": 1,
                                          "tables": [{"rows": [["a", "b"], ["1", "3"]]}]}]}}
        metrics = ocr_bench.compute_metrics(index, recognition, truth)
        self.assertEqual(0.75, metrics["tableCellAccuracy"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
