# bwts-egcs-maintenance — 작업 규칙 (Claude 필독)

**이 리포가 BWTS/EGCS 관련 유일한 현행 코드다.** 관리대장 웹(GitHub Pages), BWTS 로그 분석 파이프라인,
공무팀 대시보드 데이터 계약, GAS(Drive 폴더/첨부/업로드 큐), GitHub Actions(메일 수집·알림) 전부 여기.
`D:\CLAUDE CODE\_보관(완료)\BWTS_EGCS_구버전_20260901\` 의 옛 폴더는 참고만 — 거기서 코드 가져오지 말 것.

## 먼저 읽을 것
- `docs/ARCHITECTURE.md` — 구조·규약·판정 규칙·알려진 차이
- `docs/DEPLOY.md` — 배포 순서, SQL 실행 이력, 자격증명 회전 기록
- `contracts/thresholds.json` — 모든 판정 임계값의 단일 출처 (숫자 하드코딩 금지)

## 배포 (자동화, 사용자에게 넘기지 말 것)
- 웹: `index.html` 의 `?v=` 2곳 + `version.json` + `js/version.js` BUILD 를 같은 값으로 → `git push origin main`
- 파이프라인: `pipelines/bwts_log/BWTS_monthly_update.bat` (env `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` 는 사용자 환경변수;
  Bash 세션에서는 안 보이므로 PowerShell 로 registry User 값을 `$env:` 에 올려 실행)
- GAS: 프로젝트 "EGCS&BWTS 정비 관리" — `clasp pull` 폴더에 `gas/SupabaseDriveIndex.gs` → `SupabaseDriveIndex.js` 복사 후 `clasp push -f`
- SQL: `sql/NNN_*.sql` 번호 순, Supabase SQL Editor (크롬 자동화로 실행 가능). 013~016 재실행 금지, 그 외 재실행 가능

## 검증 없이 완료 보고 금지
- 웹: 실제 Pages 에서 탭 렌더·콘솔 에러 0 확인 (`docs/DEPLOY.md` 로컬 모의 데이터 절차)
- 파이프라인: `pytest pipelines/bwts_log/tests` + `run.py --dry-run` 분포 비교
- 판독실패/판정 검토: `/bwts-review` 스킬

## 하지 말 것
- `pipelines/bwts_log/analysis.py`, `csv_parser.py` 의 5~10ppm 리터럴을 "기준"으로 삼지 말 것 — 레거시 경로. 기준은 thresholds.json
- G드라이브 원본 PDF 삭제·이동 금지 (변환 CSV 생성·`.bad.csv` 격리만 허용)
- Supabase `grade` 컬럼 직접 수정 금지 — 검토 결과는 `final_grade`
