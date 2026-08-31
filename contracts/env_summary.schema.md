# 환경파트 데이터 계약 (공무팀 대시보드용)

환경기술파트(BWTS/EGCS) 현황을 공무팀 대시보드(Dash)가 그대로 읽을 수 있는 형태로 제공합니다.
**Dash 코드는 이 파일들을 읽기만 하면 되고, 값의 계산·판정은 전부 이쪽에서 끝나 있습니다.**

## 1. 위치 (1순위 — 파일)

```
G:\공유 드라이브\고려에스엠 0030 공무팀\공무팀 AI\AI 대쉬보드 (공무팀)\환경\data\
  env_summary.json        KPI 한 줄
  bwts_calibration.json   BWTS TRO 센서 검교정 (선박별 1행)
  egcs_calibration.json   EGCS WMS 센서 검교정·신환 (센서·구분별 1행)
  repairs_open.json       진행 중 수리
  bwts_log_latest.json    BWTS 로그 분석 최근 3개월 (선박×월)
```

- 갱신: `pipelines/bwts_log/export_contract.py` (월간 갱신 bat 에 포함, 수동 실행도 가능).
  파일은 임시파일 → rename 으로 교체되므로 읽는 중에 반토막 파일을 볼 일은 없습니다.
- 모든 파일 공통 헤더: `contract`(버전), `generated_at`(UTC ISO), `thresholds_version`.
  **`generated_at` 이 7일 이상 오래됐으면 화면에 "갱신 지연" 표시 권장.**

## 2. 위치 (2순위 — REST, 선택)

같은 내용이 Supabase 뷰로도 있습니다: `v_env_summary`, `v_calibration_status`, `v_repairs_open`,
`v_bwts_log_latest`. `https://ivsjskywdtsnoxhnozcd.supabase.co/rest/v1/<뷰명>` + 로그인 JWT.
사내 로그인이 필요하므로 파일 방식이 더 간단합니다. 필요 시 전용 계정 발급 요청.

## 3. 필드

### env_summary.json
| 필드 | 뜻 |
|---|---|
| bwts_target | BWTS 관리 대상 선박 수 (숨김 제외) |
| egcs_target | EGCS 탑재 선박 수 |
| status_ok / status_repairing / status_issue | 현황 탭 상태 — 정상 / 수리중 / 문제(보류) 선박 수 |
| repairs_open | 완료 아닌 수리 건수 |
| cal_expired / cal_soon / cal_ok / cal_unknown | 검교정 전체 만료 / 임박 / 정상 / 미상 (BWTS+EGCS 합) |
| bwts_expired / bwts_soon | BWTS 만 |
| egcs_cal_expired / egcs_repl_expired | EGCS 검교정 만료 / 신환 만료 |
| bwts_log_latest_period | 로그 분석 최신 월 `YYYY-MM` |
| bwts_log_latest_grades | 그 달 등급 분포 `{"운전양호": 12, "점검필요": 5, ...}` |
| bwts_log_review_pending | 재검토 대기 건수 |

### bwts_calibration.json / egcs_calibration.json → `rows[]`
| 필드 | 뜻 |
|---|---|
| ship_code, system, equip | 선박 코드, BWTS/EGCS, 장비 (EGCS: `WMS1/PH` 등) |
| kind | `cal`(검교정) / `repl`(신환, EGCS 만) |
| last_date, due_date, days_left | 최근 검교정일, 만료일, 남은 일수(음수 = 경과) |
| level | `ok` / `soon` / `expired` / `unknown` — **이 값만 쓰면 됨** (임박 기준: BWTS 60일, EGCS 30일) |
| model, serial, note, cert_url | 참고 |

### repairs_open.json → `rows[]`
`id, ship_code, system, date, equip, stage, symptom, action, origin, email_link, file_url`
stage 값: 미확인 / 확인 / 수리준비중 / 자재준비중 / 방선예정 (완료는 제외됨)

### bwts_log_latest.json → `rows[]`
| 필드 | 뜻 |
|---|---|
| ship_code, period | 선박, `YYYY-MM` |
| display_grade | **표시용 등급** (사람이 검토해 바꿨으면 그 값) |
| grade | 자동 판정 (참고) |
| review_status | auto / requested / reviewed / overridden |
| ballast_count, deballast_count, trip_count, alarm_count, tro_b_avg, tro_d_max | 참고 수치 |

등급: 운전양호(초록) / 점검필요(주황) / 수리후정상(파랑) / 미운전(회색) / 미수신(빨강) / 데이터불량(보라) /
**판독실패(노랑)** — 판독실패 = 로그는 있는데 자동 파서가 못 읽은 것. 미운전과 다름.

## 4. 읽기 예시 (pandas)

```python
import json, pandas as pd
D = r"G:\공유 드라이브\고려에스엠 0030 공무팀\공무팀 AI\AI 대쉬보드 (공무팀)\환경\data"
kpi = json.load(open(f"{D}/env_summary.json", encoding="utf-8"))
cal = pd.DataFrame(json.load(open(f"{D}/egcs_calibration.json", encoding="utf-8"))["rows"])
urgent = cal[cal.level.isin(["expired", "soon"])].sort_values("days_left").head(6)
```

## 5. 변경 정책
- 필드 추가는 예고 없이 할 수 있음(기존 필드는 유지). 필드 삭제·의미 변경 시 `contract` 버전 올리고 사전 공유.
- 담당: 환경기술파트 정현우 (hwjung@ekmtc.com). 소스: `hwjung-bit/bwts-egcs-maintenance` `sql/020_env_views.sql`.
