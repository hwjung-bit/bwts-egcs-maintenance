# Wide "ECS DATA LOG" layout of the 8.7K newbuilds (KLB 2026-09):
# lowercase header, newest row first, two-train mode "1-B,2-B".
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pdf_converter import parse_data_lines  # noqa: E402

HEADER = "time Operation GPS CSU1 FTS1 FMU1 REC1_STATE_CURRENT REC1_STATE_VOLTAGE TSU1_BP1 TSU1_BP2 TSU1_BP3"
LINES = [
    "ECS DATA LOG",
    "SHIP NAME : long beach",
    "LOG DATE : 2026-10-01",
    HEADER,
    "2026-09-30 23:59:49 1-B,2-B [10, 9.10, N],[110, 12.05, E] 32.41 34.01 763.44 1822.0 3.8 5.10 0.0 0.0",
    "2026-09-30 23:58:49 1-B [10, 9.36, N],[110, 12.16, E] 32.36 33.76 770.43 1834.0 3.8 6.24 0.0 0.0",
    # idle row without a mode: not data
    "2026-09-30 11:07:58 [13, 26.78, N],[111, 42.13, E] 32.9 34.06 715.32 0.0 0.0 0.0 0.0 0.0",
    "ECS DATA LOG",
    HEADER,
    "2026-09-17 06:16:45 2-D [35, 6.20, N],[129, 5.14, E] 30.31 36.41 0.0 0.0 0.0 0.0 0.0 0.02",
]


def test_wide_layout_becomes_index_time_operation_csv():
    header, rows = parse_data_lines(LINES)
    assert header[:4] == ["INDEX", "TIME", "OPERATION", "GPS"]
    assert "TSU1_BP1" in header and "REC1_STATE_CURRENT" in header
    assert len(rows) == 3
    # sorted oldest first, re-indexed
    assert [r[1] for r in rows] == ["2026-09-17 06:16:45",
                                    "2026-09-30 23:58:49",
                                    "2026-09-30 23:59:49"]
    assert [r[0] for r in rows] == ["1", "2", "3"]
    assert rows[2][2] == "1-B,2-B"
    assert rows[1][header.index("TSU1_BP1")] == "6.24"


def test_old_layout_untouched():
    lines = ["INDEX  TIME  OPERATION  TRO_B1",
             "1  2026-8-15 18:9:29  1-B  0.00"]
    header, rows = parse_data_lines(lines)
    assert header[0] == "INDEX" and len(rows) == 1
