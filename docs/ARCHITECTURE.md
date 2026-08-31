# 구조 (V3, 2026-09-01)

```
[G:\...\011  BWTS\4. BWTS LOG DATA]  ← GAS BwtsLogSave.gs (Gmail→PDF→Drive, 5분)
        │ 로컬 PC: pipelines/bwts_log/run.py  (분석 → integrity → publish → export)
        ▼
[Supabase ivsjskywdtsnoxhnozcd]
   ships · mail_log · repairs · calibrations · config · drive_folders · folder_*   (001~017)
   bwts_log_analysis · bwts_reviews                                             (018·019)
   app_thresholds · sensor_cycles · v_env_summary · v_calibration_status · ...  (020·021)
        │ supabase-js (Google 로그인, RLS app_is_staff)     │ export_contract.py
        ▼                                                    ▼
[GitHub Pages index.html — ES 모듈]                  [G:\...\공무팀 AI\...\환경\data\*.json]
   home · mail · repairs · status · bwtsLog ·                 → 이원우님 Dash (공무팀 대시보드)
   bwtsCal · egcsCal · ships
        │ 「재검토 요청」
        ▼
[로컬 Claude CLI  /bwts-review]  → review_io.py → 원본 CSV 재판정 → final_grade / 파서 수정 + 픽스처
```

## 프론트 (빌드 없음)
- `index.html` 은 셸. `js/app.js?v=X` 가 `contracts/thresholds.json` → auth → router 순으로 부트.
- `js/core/router.js` `TABS` 배열 = 탭바. 탭 모듈은 `js/tabs/<id>.js`,
  `export default { id, mount(root), refresh(), setParams?, destroy? }`.
  router 가 `import()` 로 지연 로드하고 mount/refresh 를 try/catch 로 감싼다 → **한 탭 오류는 그 탭 카드로 격리**.
- HTML 문자열 안의 핸들러는 `window.<id>Tab.<fn>` (예 `mailTab.deleteMail`). 모듈 스코프라 전역 함수가 없기 때문.
- 상태는 `js/core/state.js` 의 `S` 하나. `loadData()` 가 6테이블을 병렬로 읽고 `data:loaded` 이벤트 → router 가 활성 탭 refresh.
- 쓰기는 전부 `dbSave()` (`js/core/supabase.js`) 경유 — supabase-js 는 실패해도 throw 하지 않는다.
- 임계값은 `js/shared/thresholds.js` `requireTH('섹션')` 으로만 읽는다. 숫자 하드코딩 금지.

## 배포
- main 푸시 = 배포. **`version.json`, `index.html` 의 `?v=` 두 곳, `js/version.js` BUILD 를 같은 값으로 올린다.**
  하위 모듈은 쿼리가 없어 Pages 가 10분 캐시한다 → app.js 가 자기 `?v` 와 `version.js` BUILD 를 비교해
  다르면 모듈 전부 `fetch(cache:'reload')` 후 1회 자동 새로고침(sessionStorage 가드로 루프 방지).
  `version.json` 은 열려 있는 탭에 "새 버전" 배너용.
- 새 탭 추가 = `router.js` TABS 한 줄 + `js/tabs/` 파일 하나. 다른 파일 안 건드림.

## 파이프라인 `pipelines/bwts_log/`
- `run.py` 진입점. `--dry-run`, `--years 2024-2026`, `--clear`, `--html`.
  `.analyzer_version` 마커가 다르면 캐시 자동 폐기(룰 변경 후 --clear 잊는 사고 방지).
- 판정: `fleet_summary.compute_grade` 6등급 → `integrity.apply_matrix` 가 미운전/데이터불량 중 원본과
  모순되는 셀을 **판독실패** 로 재판정 (I1~I7, docstring 참조). 운전 등급은 절대 건드리지 않음.
- `publish_supabase.py` 는 `review_*`/`final_grade` 를 보내지 않으므로 재실행해도 검토 결과 보존.
- `export_contract.py` 는 thresholds.json → `app_thresholds`/`sensor_cycles` 미러 후 계약 뷰를 JSON 으로 내보냄.
- 레거시: `fleet_dashboard.py`(바탕화면 HTML), `analysis.py`/`csv_parser.py` 안의 5~10ppm 리터럴은
  bwts_analyzer 경로용 — fleet 판정에는 안 쓰임. 지울 때 같이 지운다.

## 검토 루프
웹 `bwtsLog` 탭 「재검토 요청」 → `bwts_reviews` + `review_status='requested'` →
로컬 `/bwts-review` 스킬 (`C:\Users\user\.claude\skills\bwts-review\SKILL.md`) 이 `review_io.py list/show/answer/label` 로
원본을 다시 보고 기록. 파서 결함이면 `csv_parser.py` 수정 + `tests/fixtures/` 추가 + `pytest`.

## 공무팀 대시보드 계약
`contracts/env_summary.schema.md`. 파일(G드라이브 JSON) 1순위, REST(뷰) 2순위. Dash 코드는 이쪽에서 건드리지 않는다.

## 알려진 차이
- 월 더하기: JS `setMonth` 는 말일 넘침을 다음 달로 밀고, SQL `make_interval` 과 `weekly_cal_alert.py` 는 말일로 클램프.
  1/31 + 1개월 → JS 3/3, SQL 2/28. 최대 3일 차이. 통일하려면 `js/shared/dates.js addMonths` 를 클램프로 바꿀 것.
