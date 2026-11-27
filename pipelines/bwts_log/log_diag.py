"""Per ship-month log diagnostic for the BWTS 로그 tab detail panel.

Reads the month's DATALOG / EVENTLOG / OPERATIONTIMELOG CSVs and builds one
payload per (ship, period): operation summary, alarm and device ranking,
per-session TRO (injection and discharge), month KPIs, trend findings over
the last window_months, and the maker-manual action for each repeated alarm.
Upserts into Supabase bwts_log_diag (sql/043). Techcross only — Alfa Laval
logs have a different structure and are skipped.

    python log_diag.py --year 2026            # every month of the year
    python log_diag.py --recent 2             # last 2 periods (daily run)
    python log_diag.py --ship KMU --dry-run

A month is re-read only when its CSV sizes changed (payload["sig"]).
"""
import argparse
import collections
import re
import sys
from datetime import date, timedelta

import config
from alarm_manual import manual
from csv_parser import parse_eventlog_csv, read_csv_rows
from fleet_log_analyzer import _parse_datalog_rows, split_sessions
from thresholds import BL, TH

LD = TH["log_diag"]
VERSION = 1
TABLE = "bwts_log_diag"
MODES = ("BALLAST", "DEBALLAST", "STRIPPING")
URG, WARN = "긴급", "주의"
LO, HI = BL["tro_ballast_min_ppm"], BL["tro_ballast_max_ppm"]
D_MAX = BL["tro_deballast_max_ppm"]


def _avg(a, n=2):
    return round(sum(a) / len(a), n) if a else None


# ── pure builders ───────────────────────────────────────────
def op_summary(rows):
    """OPERATIONTIMELOG rows -> {mode: [count, minutes, volume]}"""
    out = {}
    for r in rows:
        m = (r[0] or "").strip().upper() if r else ""
        if m not in MODES or len(r) < 6:
            continue
        o = out.setdefault(m, [0, 0, 0.0])
        hm = re.match(r"(\d+):(\d+)", (r[3] or "").strip())
        o[0] += 1
        o[1] += int(hm.group(1)) * 60 + int(hm.group(2)) if hm else 0
        try:
            o[2] = round(o[2] + float((r[5] or "0").split("(")[0]), 2)
        except ValueError:
            pass
    return out


def alarm_stats(alarms):
    """parse_eventlog_csv alarms -> (per-code list, per-device list). Simulation tests excluded."""
    codes, devs = collections.OrderedDict(), collections.OrderedDict()
    for a in alarms:
        desc = re.sub(r"\[[-\d.\s]*\]", "", a.get("description") or "").strip(" .")
        if "SIMUL" in desc.upper():
            continue
        code = a.get("code") or ""
        k = "T" if a.get("level") == "Trip" else "A"
        c = codes.setdefault(code or desc[:20], {"code": code, "A": 0, "T": 0, "days": set(),
                                                 "dc": collections.Counter()})
        c[k] += 1
        c["days"].add((a.get("date") or "")[:10].strip())
        c["dc"][desc] += 1
        d = devs.setdefault(a.get("device") or "-", {"A": 0, "T": 0, "c": collections.Counter()})
        d[k] += 1
        d["c"][f"[{code}] {desc}"] += 1
    out = []
    for c in codes.values():
        desc = c["dc"].most_common(1)[0][0]
        name, acts, ref, backed = manual(c["code"], desc)
        num = c["code"].replace("CODE", "")
        show = (num not in LD["ignore_codes"]
                and (c["T"] >= 1 or c["A"] + c["T"] >= LD["action_min_total"]))
        out.append({"code": c["code"], "desc": desc[:80], "A": c["A"], "T": c["T"], "days": len(c["days"]),
                    "major": num in LD["major_codes"], "name": name,
                    "actions": acts if show else [], "ref": ref if show else "", "manual": backed})
    out.sort(key=lambda x: -(x["A"] + x["T"]))
    dv = [{"dev": k, "A": v["A"], "T": v["T"], "top": v["c"].most_common(1)[0][0][:90]}
          for k, v in devs.items()]
    dv.sort(key=lambda x: -(x["A"] + x["T"]))
    return out, dv


def session_stats(sessions):
    """split_sessions output -> per-session TRO rows (warm-up excluded)."""
    warm = timedelta(minutes=BL["warmup_minutes"])
    out = []
    for s in sessions:
        if s["mode"] not in ("BALLAST", "DEBALLAST"):
            continue
        t0 = s["start_time"]
        st = [r for r in s["rows"] if not (t0 and r["time"]) or r["time"] - t0 >= warm]
        o = {"mode": s["mode"], "start": t0.strftime("%m-%d %H:%M") if t0 else (s["date"] or ""),
             "min": s["duration_min"]}
        if s["mode"] == "BALLAST":
            gen = [r for r in st if (r["current"] or 0) >= LD["gen_min_amp"]]
            ts = [r["tro_b"] for r in gen]
            o["n"] = len(gen)
            if len(gen) >= LD["session_min_rows"]:
                o.update(amp=_avg([r["current"] for r in gen], 0), tro=_avg(ts), tmin=min(ts), tmax=max(ts),
                         inr=round(sum(1 for t in ts if LO <= t <= HI) / len(ts), 2),
                         zero=round(sum(1 for t in ts if t == 0) / len(ts), 2))
                o["ok"] = LO <= o["tro"] <= HI
        else:
            td = [r["tro_d"] for r in st]
            o["n"] = len(td)
            if len(td) >= LD["session_min_rows"]:
                o.update(davg=_avg(td), dmax=max(td), dover=sum(1 for t in td if t > D_MAX))
                o["ok"] = o["dover"] == 0
        out.append(o)
    return out


def month_kpi(rows, sessions, alarms):
    """Month KPIs from parsed DataLog rows + session rows + alarm list."""
    b = [r for r in rows if r["mode"] == "BALLAST"]
    gen = [r for r in b if (r["current"] or 0) >= LD["gen_min_amp"]]
    k = {"b_rows": len(b), "gen_rows": len(gen),
         "alarm": sum(a["A"] for a in alarms), "trip": sum(a["T"] for a in alarms)}
    if gen:
        ts = [r["tro_b"] for r in gen]
        nz = [t for t in ts if t > 0]
        k.update(tro_avg=_avg(nz), tro_zero=round(1 - len(nz) / len(ts), 3),
                 tro_in=round(sum(1 for t in ts if LO <= t <= HI) / len(ts), 3),
                 tro_hi=round(sum(1 for t in ts if t > HI) / len(ts), 3),
                 amp=_avg([r["current"] for r in gen], 0),
                 volt=_avg([r["voltage"] for r in gen if r["voltage"]]),
                 csu=_avg([r["csu"] for r in gen if r["csu"] is not None], 1),
                 fmu=_avg([r["fmu"] for r in gen if r["fmu"]], 0))
    bs = [s for s in sessions if s["mode"] == "BALLAST" and "ok" in s]
    ds = [s for s in sessions if s["mode"] == "DEBALLAST" and "ok" in s]
    k.update(inj_n=len(bs), inj_ok=sum(s["ok"] for s in bs), dis_n=len(ds), dis_over=sum(not s["ok"] for s in ds))
    return k


def _act(code, desc=""):
    name, acts, ref, _ = manual(code, desc)
    return acts, ref


def findings(window):
    """window: [(period, payload)] oldest first, target month last -> finding list."""
    per, cur = window[-1]
    k = cur["kpi"]
    mm = lambda p: p[5:] + "월"
    big = lambda x: x.get("gen_rows", 0) >= LD["month_min_rows"]
    has = lambda pl, *codes: any(a["code"].replace("CODE", "") in codes for a in pl["alarms"])
    out = []
    if k["inj_n"] >= 2 and k["inj_ok"] / k["inj_n"] < LD["inj_ok_ratio"]:
        bs = [s for s in cur["sessions"] if s["mode"] == "BALLAST" and "ok" in s]
        acts, ref = _act("CODE200")
        out.append({"lv": URG if k["inj_ok"] == 0 else WARN, "title": "주입 TRO 미달",
                    "evidence": [f"{mm(per)} 밸러스팅 {k['inj_n']}회 중 {LO:g}~{HI:g} ppm 충족 {k['inj_ok']}회",
                                 "세션 평균 TRO: " + ", ".join(f"{s['start'][:5]} {s['tro']}" for s in bs[:8])],
                    "actions": acts, "ref": ref})
    zero = [p for p, pl in window if big(pl["kpi"]) and (pl["kpi"].get("tro_zero") or 0) >= LD["zero_ratio"]]
    s220 = [p for p, pl in window if has(pl, "220", "240")]
    if len(zero) >= 2 or len(s220) >= 2 or (zero and s220):
        n = sum(a["A"] + a["T"] for _, pl in window for a in pl["alarms"]
                if a["code"] in ("CODE220", "CODE240"))
        ev = []
        if zero:
            ev.append(f"정류기 가동 중 TRO 0.00 기록 비율 {LD['zero_ratio'] * 100:.0f}% 이상: "
                      + ", ".join(f"{mm(p)} {dict(window)[p]['kpi']['tro_zero'] * 100:.0f}%" for p in zero))
        if s220:
            ev.append(f"TRO 센서 No Intake Water / Purge Clogged 알람 {n}회 ({', '.join(mm(p) for p in s220)})")
        a1, r1 = _act("CODE220")
        a2, _ = _act("CODE240", "Purge")
        out.append({"lv": URG if len(zero) >= 2 else WARN, "title": "TRO 센서 측정 불량 (샘플수 유입)",
                    "evidence": ev, "actions": a1 + a2[:2], "ref": "OMSM 7.3.1.1 p.147~150"})
    low = [p for p, pl in window if big(pl["kpi"]) and (pl["kpi"].get("tro_zero") or 0) < LD["zero_ratio"]
           and (pl["kpi"].get("tro_avg") or 99) < LO]
    if len(low) >= 2:
        acts, ref = _act("CODE200")
        out.append({"lv": URG if len(low) >= 3 else WARN, "title": "TRO 생성 부족 (연속)",
                    "evidence": [f"주입 TRO 평균 {LO:g} ppm 미만: "
                                 + ", ".join(f"{mm(p)} {dict(window)[p]['kpi']['tro_avg']}" for p in low)],
                    "actions": acts, "ref": ref})
    hi = [p for p, pl in window if big(pl["kpi"]) and (pl["kpi"].get("tro_hi") or 0) >= LD["high_ratio"]]
    if len(hi) >= 2:
        acts, ref = _act("CODE201")
        out.append({"lv": WARN, "title": "주입 TRO 과다 (연속)",
                    "evidence": [f"{HI:g} ppm 초과 비율 {LD['high_ratio'] * 100:.0f}% 이상: "
                                 + ", ".join(f"{mm(p)} {dict(window)[p]['kpi']['tro_hi'] * 100:.0f}%" for p in hi)],
                    "actions": acts, "ref": ref})
    nod = [p for p, pl in window if pl["kpi"].get("b_rows", 0) > 0 and pl["kpi"].get("gen_rows", 0) == 0]
    if len(nod) >= 3:
        out.append({"lv": WARN, "title": "정류기 가동 기록 없음",
                    "evidence": [f"{', '.join(mm(p) for p in nod)} 밸러스팅 행은 있으나 "
                                 f"전류 {LD['gen_min_amp']} A 이상 행 없음"],
                    "actions": ["밸러스팅 실적과 BWRB 대조, 처리 운전 여부 회신"], "ref": ""})
    return out


def status_of(payload):
    f = payload.get("findings", [])
    if any(x["lv"] == URG for x in f):
        return "Alert"
    if f or any(a["major"] and a["T"] >= 2 for a in payload["alarms"]):
        return "Warn"
    return "Normal"


# ── file reading ────────────────────────────────────────────
def signature(files):
    return "|".join(f"{k}:{files[k].stat().st_size}" if files.get(k) else f"{k}:-"
                    for k in ("optime", "datalog", "eventlog")) + f"|v{VERSION}"


def build_month(files):
    """Month payload without findings (those need the window)."""
    rows = _parse_datalog_rows(str(files["datalog"])) if files.get("datalog") else []
    ev = parse_eventlog_csv(str(files["eventlog"])).get("alarms", []) if files.get("eventlog") else []
    alarms, devices = alarm_stats(ev)
    sessions = session_stats(split_sessions(rows))
    return {"v": VERSION, "files": {k: files[k].name for k in ("optime", "datalog", "eventlog") if files.get(k)},
            "op": op_summary(read_csv_rows(str(files["optime"]))) if files.get("optime") else {},
            "alarms": alarms, "devices": devices, "sessions": sessions,
            "kpi": month_kpi(rows, sessions, alarms)}


def prev_periods(period, n):
    y, m = int(period[:4]), int(period[5:])
    out = []
    for _ in range(n):
        out.append(f"{y}-{m:02d}")
        y, m = (y, m - 1) if m > 1 else (y - 1, 12)
    return out[::-1]


def run(periods, ships, sb, dry):
    stored = {}
    if sb:
        for r in sb.table(TABLE).select("ship_code,period,payload").execute().data:
            stored[(r["ship_code"], r["period"])] = r["payload"]
    done = collections.Counter()
    for v in config.VESSELS:
        code = v["code"]
        if ships and code not in ships:
            continue
        cache, fresh = {}, set()

        def month(p):
            if p not in cache:
                y, m = int(p[:4]), int(p[5:])
                cache[p] = None
                if config.in_service(v, y, m) and config.maker_at(v, y, m) == "techcross":
                    folder = config.get_vessel_folder(y, m, code)
                    files = config.get_csv_files(folder, auto_extract_zip=False) if folder else {}
                    if files.get("datalog") or files.get("eventlog"):
                        sig = signature(files)
                        old = stored.get((code, p))
                        if old and old.get("sig") == sig:
                            cache[p] = old
                        else:
                            cache[p] = dict(build_month(files), sig=sig)
                            fresh.add(p)
            return cache[p]

        for p in periods:
            try:
                win = [(q, month(q)) for q in prev_periods(p, LD["window_months"])]
            except Exception as e:                                   # one bad file must not stop the fleet
                print(f"  ERR {code} {p}: {e!r}"[:200])
                done["error"] += 1
                continue
            win = [(q, pl) for q, pl in win if pl]
            if not win or win[-1][0] != p:
                continue
            pl = win[-1][1]
            if p not in fresh and not any(q in fresh for q, _ in win):
                done["unchanged"] += 1
                continue
            pl["findings"] = findings(win)
            pl["status"] = status_of(pl)
            done[pl["status"]] += 1
            print(f"  {code} {p} {pl['status']:6} inj {pl['kpi']['inj_ok']}/{pl['kpi']['inj_n']} "
                  f"alarm {pl['kpi']['alarm']} trip {pl['kpi']['trip']} "
                  + " / ".join(f["title"] for f in pl["findings"]))
            if sb and not dry:
                sb.table(TABLE).upsert({"ship_code": code, "period": p, "payload": pl,
                                        "updated_at": date.today().isoformat()}).execute()
    print("log_diag:", dict(done))
    return done


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int)
    ap.add_argument("--recent", type=int, help="last N periods up to the previous month")
    ap.add_argument("--ship", action="append")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--no-db", action="store_true", help="do not read stored payloads (full rebuild, no upsert)")
    a = ap.parse_args()
    t = date.today()
    last = f"{t.year}-{t.month - 1:02d}" if t.month > 1 else f"{t.year - 1}-12"
    if a.year:
        periods = [f"{a.year}-{m:02d}" for m in range(1, 13) if f"{a.year}-{m:02d}" <= last]
    else:
        periods = prev_periods(last, a.recent or 2)
    sb = None
    if not a.no_db:
        from publish_supabase import get_client
        sb = get_client()
    run(periods, set(a.ship or []), sb, a.dry_run or a.no_db)


if __name__ == "__main__":
    sys.exit(main())
