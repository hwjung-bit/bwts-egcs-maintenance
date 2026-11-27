"""log_diag pure builders — no G: / DB."""
import sys
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import log_diag as ld  # noqa: E402
from alarm_manual import manual  # noqa: E402


def rows(mode, n, tro, amp=2000, start=datetime(2026, 10, 1, 0, 0)):
    return [{"time": start + timedelta(minutes=i), "date": "2026-10-01", "mode": mode, "current": amp,
             "voltage": 5, "csu": 30, "fmu": 500, "fts": 30, "tro_b": tro, "tro_d": tro} for i in range(n)]


def sess(mode, n, tro, **kw):
    r = rows(mode, n, tro, **kw)
    return {"mode": mode, "date": "2026-10-01", "start_time": r[0]["time"], "end_time": r[-1]["time"],
            "duration_min": n - 1, "rows": r}


def test_op_summary_counts_time_volume():
    r = [["OPERATION", "START", "END", "RUN", "GPS", "VOL", "Line"],
         ["BALLAST", "a", "b", "0:17", "g", "29.00", "1"], ["Ballast", "a", "b", "01:06", "g", "826", "2"],
         ["DEBALLAST", "a", "b", "0:30", "g", "100(200)", "1"], ["TOTAL TIME : 04:14:00", "", "", "", "", "", ""]]
    assert ld.op_summary(r) == {"BALLAST": [2, 83, 855.0], "DEBALLAST": [1, 30, 100.0]}


def test_alarm_stats_split_and_simulation_excluded():
    ev = [{"date": "2026-10-1 1:0:0", "level": "Trip", "code": "CODE100", "description": "ECU (P.S Pressure High)[4.61]",
           "device": "ECU1"},
          {"date": "2026-10-2 1:0:0", "level": "Alarm", "code": "CODE100", "description": "ECU (P.S Pressure High)",
           "device": "ECU1"},
          {"date": "2026-10-2 1:0:0", "level": "Trip", "code": "CODE606", "description": "Detected H2 Gas.[SIMUL]",
           "device": "GDS"}]
    codes, devs = ld.alarm_stats(ev)
    assert [(c["code"], c["A"], c["T"], c["days"], c["major"]) for c in codes] == [("CODE100", 1, 1, 2, True)]
    assert codes[0]["actions"] and "p.144" in codes[0]["ref"]
    assert devs == [{"dev": "ECU1", "A": 1, "T": 1, "top": "[CODE100] ECU (P.S Pressure High)"}]


def test_session_stats_warmup_and_hold():
    out = ld.session_stats([sess("BALLAST", 30, 7.0), sess("BALLAST", 12, 7.0), sess("BALLAST", 30, 0.0),
                            sess("DEBALLAST", 30, 0.2)])
    assert out[0]["ok"] is True and out[0]["n"] == 20 and out[0]["tro"] == 7.0
    assert "ok" not in out[1]                       # 2 steady rows < session_min_rows -> held
    assert out[2]["ok"] is False and out[2]["zero"] == 1.0
    assert out[3]["ok"] is False and out[3]["dover"] == 20


def payload(inj_ok, inj_n, zero=0.0, avg=7.0, codes=()):
    ss = [{"mode": "BALLAST", "start": "10-01 00:00", "tro": 7.0 if i < inj_ok else 1.0, "ok": i < inj_ok}
          for i in range(inj_n)]
    return {"kpi": {"inj_n": inj_n, "inj_ok": inj_ok, "b_rows": 50, "gen_rows": 50, "tro_zero": zero,
                    "tro_avg": avg, "tro_hi": 0.0},
            "sessions": ss, "alarms": [{"code": c, "A": 3, "T": 0, "major": False} for c in codes]}


def titles(win):
    return [(f["lv"], f["title"]) for f in ld.findings(win)]


def test_findings_single_month_injection_miss():
    assert titles([("2026-10", payload(0, 3))]) == [("긴급", "주입 TRO 미달")]
    assert titles([("2026-10", payload(1, 3))]) == [("주의", "주입 TRO 미달")]
    assert titles([("2026-10", payload(2, 3))]) == []
    assert titles([("2026-10", payload(0, 1))]) == []          # one session is not enough


def test_findings_sensor_defect_needs_repeat_or_alarm():
    one = [("2026-09", payload(2, 2)), ("2026-10", payload(2, 2, zero=0.9))]
    assert titles(one) == []
    two = [("2026-09", payload(2, 2, zero=0.9)), ("2026-10", payload(2, 2, zero=0.9))]
    assert titles(two) == [("긴급", "TRO 센서 측정 불량 (샘플수 유입)")]
    mix = [("2026-09", payload(2, 2, codes=("CODE220",))), ("2026-10", payload(2, 2, zero=0.9))]
    assert titles(mix) == [("주의", "TRO 센서 측정 불량 (샘플수 유입)")]


def test_findings_low_generation_two_months():
    win = [("2026-09", payload(2, 2, avg=3.0)), ("2026-10", payload(2, 2, avg=4.0))]
    assert titles(win) == [("주의", "TRO 생성 부족 (연속)")]


def test_status():
    assert ld.status_of({"findings": [{"lv": "긴급"}], "alarms": []}) == "Alert"
    assert ld.status_of({"findings": [], "alarms": [{"major": True, "T": 2}]}) == "Warn"
    assert ld.status_of({"findings": [], "alarms": [{"major": False, "T": 5}]}) == "Normal"


def test_manual_lookup():
    assert manual("CODE240", "Sensor Fail : Purge Clogged[TRO SENSOR1]")[0] == "TRO 센서 퍼지 막힘"
    assert manual("CODE302", "Tank Level Low")[2] == "OMSM 7.2 p.139~140, 7.3.2.3 p.154"
    name, acts, ref, backed = manual("CODE721", "Valve Opened.[BA011F]")
    assert backed is False and "미수록" in ref


def test_prev_periods_crosses_year():
    assert ld.prev_periods("2027-02", 4) == ["2026-11", "2026-12", "2027-01", "2027-02"]
