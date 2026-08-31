# 배포 순서 — hardening-2026-08

이번 변경은 SQL · 프론트 · GAS 가 서로를 필요로 한다. 순서를 틀리면
폴더 요청 큐가 통째로 멈춘다. 아래 순서를 지킬 것.

## 배경

2026-08-29~31, Gmail OAuth 토큰이 만료돼 `collect` 가 2시간마다 이틀간
실패했는데 아무도 몰랐다. 원인 추적 중 전수 점검을 했고 63건이 나왔다.
핵심은 기능 결함이 아니라 **실패가 성공처럼 보이는 구조**였다.

전체 소견은 점검 소견서 참조.

## 1. SQL 먼저 (코드 배포 전)

Supabase SQL Editor 에서 순서대로. 전부 재실행 가능하다.

| 순서 | 파일 | 내용 |
|------|------|------|
| 1 | `sql/013_folder_requests_msg_id.sql` | `msg_id` 컬럼 + 기존 pending 백필 |
| 2 | `sql/014_rls_lockdown.sql` | **anon 차단** + 누락된 DELETE/INSERT/UPDATE 정책 |
| 3 | `sql/015_integrity.sql` | `thread_id` UNIQUE, FK, 큐 재시도 컬럼 |
| 4 | `sql/016_ships_status.sql` | 현황 탭 8개 컬럼 성문화 |

**014 가 가장 급하다.** 적용 전까지는 공개된 anon 키로 사내 메일 본문
전량이 인터넷에서 조회된다.

**015 는 데이터가 더러우면 일부러 멈춘다.** 아래 중 하나가 뜨면 메시지가
지시하는 대로 정리한 뒤 다시 실행:

- `thread_id 중복 N 건` → `007_thread_merge.sql` 먼저 실행
- `ships 에 없는 ship_code: ...` → 선박 마스터에 추가하거나 해당 행 수정

015 는 FK 를 걸기 전에 `ship_code = ''` 를 NULL 로 정규화한다. 2026-08-31
기준 `mail_log` 402건 중 112건이 여기 해당한다 (선박을 못 찾은 메일).
빈 문자열은 `ships.code` 에 없는 값이라 FK 가 거부하는데, "미상"은 NULL 이
맞는 표현이기도 하다. 수집기도 이제 `None` 을 쓴다.

`folder_requests` 에는 일부러 FK 를 걸지 않았다. `ON DELETE CASCADE` 를
걸면 프론트가 삭제 직전에 남기는 `status='cancelled'` 표시가 함께 지워져,
GAS 가 처리 중이던 요청이 고아 폴더를 만들고도 아무 기록을 남기지 않는다.

### 적용 확인

```sql
-- anon 에 열린 정책이 남아 있는지 (0 이어야 함)
SELECT tablename, policyname, roles FROM pg_policies
 WHERE schemaname = 'public' AND 'anon' = ANY(roles);
```

```bash
# 익명 조회가 막혔는지 (빈 배열 [] 이어야 함)
curl -s "https://ivsjskywdtsnoxhnozcd.supabase.co/rest/v1/mail_log?select=id&limit=1" \
  -H "apikey: <index.html 의 anon 키>"
```

### 운영 DB 에서는 013~016 네 개만

001~012 를 다시 돌리지 말 것. 특히:

- **005** 는 새 가드가 일부러 EXCEPTION 을 던진다 (수기 분류 보호)
- **006** 은 재실행하면 백업 테이블만 다시 만든다
- **007** 의 3단계 DELETE 는 이미 병합된 상태에서 불필요한 위험

009·012 등은 멱등하지만 실익이 없다. 클린 DB 재구축 시에만 001→016 전체.

## 2. 프론트 배포

`index.html` 을 main 에 머지 → GitHub Pages 자동 반영.

**013 과 014 적용 후에 올려야 한다.** 순서가 바뀌면:

- 013 없이 올리면 프론트가 `folder_requests` 에 넣는 `msg_id` 컬럼이 없어
  PostgREST 400 → `mailToRepair` 가 폴더 요청 실패를 무시한 채 원본 메일을
  지운다 → **폴더 요청 영구 유실**
- 014 없이 올리면 `status='cancelled'` UPDATE 가 정책 부재로 조용히 0행

**Pages 반영 후에도 브라우저가 옛 index.html 을 계속 쓴다.** 확인할 때는
`?v=<날짜>` 를 붙이거나 하드 리로드할 것. 이걸 몰라서 "고쳤는데 여전히 안 된다"로
한참 헤맸다. 서버 반영 여부는 아래로 확인:

```bash
curl -s "https://hwjung-bit.github.io/bwts-egcs-maintenance/index.html" \
  | grep -c "input.blur()"
```

배포 후 로그인해서 확인:

- 각 탭이 정상 로드되는지 (실패 시 이제 실패 토스트가 뜬다)
- 현황 탭 메모 저장 후 **새로고침해도 남아 있는지**
  (기존에는 존재하지 않는 컬럼에 써서 조용히 사라졌다)
- 수리이력 삭제가 실제로 반영되는지
  (기존에는 DELETE 정책이 없어 새로고침하면 되살아났다)

## 3. GAS 배포

**015 적용 후에** `gas/SupabaseDriveIndex.gs` 를 GAS 에디터에 붙여넣고 저장.

015 없이 올리면 `claimRequests_` 가 없는 `locked_at`·`attempts` 컬럼을
필터·기록해 400 이 나고, `processFolderRequests` 의 try/catch 가 그걸
삼켜서 **생성·삭제 큐가 둘 다 Logger 한 줄만 남기고 조용히 죽는다.**

**저장만으로는 안 된다.** `GmailApp` 도입으로 OAuth 스코프가 늘어나서,
기존 시간 기반 트리거는 소유자가 에디터에서 **1회 수동 실행해 재승인**하기
전까지 authorization 오류로 실패한다. 그동안 생성·삭제 큐가 둘 다 멈춘다.

```
에디터에서 processFolderRequests 1회 실행 → 권한 승인 → 로그 확인
```

실행 로그에 `큐: 다른 실행이 진행 중` 만 반복해서 뜨면 `LockService` 락이
남은 것이다. 몇 분 기다리면 자동 해제된다.

## 4. 시크릿

```bash
# drive-index 가 이걸 우선 사용한다. 8/20 자 구버전이면 여전히 실패한다.
gh secret set DRIVE_TOKEN_JSON --repo hwjung-bit/bwts-egcs-maintenance < <새 토큰 JSON>
```

`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 은 폐기된 웹앱 클라이언트를
가리킨다. 토큰 JSON 안에 값이 박혀 있어 당장 동작하지만, 다음 재발급 때
혼선을 부르므로 새 데스크톱 클라이언트 값으로 맞춰둘 것.

## 5. 배포 후 감시

첫 24시간 동안 아래를 확인한다. 이번 변경의 핵심이 "실패를 소리나게
만드는 것"이라, 오히려 **오탐이 나면 즉시 되돌려야** 한다.

- `collect` 가 2시간마다 성공하는지 (Actions 탭)
- 조용한 밤에 실패 알림 메일이 오지 **않는지** — 오면 종료코드 조건이
  너무 빡빡한 것이니 해당 스크립트를 손볼 것
- 다음 월요일 08:00 KST 검교정 알림이 정상 발송되는지
- 하트비트가 조용한지

**하트비트는 새 수집기가 한 번 성공한 뒤에 켤 것.** `config['last_collect_ok']`
는 새 수집기가 처음 성공해야 생긴다. 먼저 켜면 첫 실행에서 "하트비트 없음"
오탐 경보가 나간다.

### 아무도 안 보는 것 하나

`status='error'` 로 굳은 큐 요청은 여전히 화면에 안 보인다. 재시도 3회를
소진한 건이라 사람이 봐야 하는데, 지금은 Supabase 를 직접 열어야 한다.
주간 점검에 넣거나 하트비트에 합칠 것:

```sql
SELECT * FROM folder_requests WHERE status = 'error';
SELECT * FROM folder_trash_requests WHERE status = 'error';
```

### 예상되는 표시 변화 (버그 아님)

`reply_count` 계산이 증가식에서 `len(thread_body) - 1` 파생식으로 바뀌었다.
007 이 병합했던 스레드 중 일부는 다음 답장이 올 때 ↩ 배지 숫자가 한 칸
내려간다. 재실행해도 부풀지 않는 대신 과거 숫자가 소급 교정되는 것이다.

## 토큰 재발급 절차 (재발 시)

`invalid_grant` / `RefreshError` 가 보이면:

1. GCP Console → OAuth 클라이언트가 **데스크톱 앱** 타입인지 확인
   (웹 애플리케이션 타입이면 `redirect_uri_mismatch` 로 재발급 자체가 실패)
2. `python scripts/make_token.py scripts/client_secret_local.json`
3. 출력 JSON 을 `GMAIL_TOKEN_JSON` **과** `DRIVE_TOKEN_JSON` 양쪽에 설정
   — 하나만 갱신하면 drive-index 는 계속 실패한다

`scripts/make_token.py` 는 refresh token 과 client secret 을 stdout 으로
출력한다. CI 에서 실행하지 말 것.

---

## V3 (2026-09-01) — 모듈 구조 이후

구조 설명은 `docs/ARCHITECTURE.md`. 여기는 배포 절차만.

### 프론트 배포
1. 코드 수정 → `node --check js/**/*.js`
2. `index.html` 의 `?v=YYYYMMDDx` **두 곳**(css, app.js), `version.json`, **`js/version.js` 의 BUILD** 를 같은 값으로 올린다.
   (하위 모듈은 `?v=` 가 없어 10분 캐시된다 — app.js 가 BUILD 불일치를 보면 모듈을 `cache:'reload'` 로 재수신 후 1회 자동 새로고침.)
3. `git push origin main` → 1~2분 후 Pages 반영. 기존 탭이 열려 있으면 상단 "새 버전" 배너가 뜬다.
4. 로컬 사전 검증: `python -m http.server 8787` → `http://127.0.0.1:8787/#<탭>` (로그인 없이 UI 확인은
   크롬 콘솔에서 `import('/js/core/state.js')` 로 `S` 채우고 `router.switchTab()` — 모듈 경로에 `?v=` 붙이지 말 것).

### SQL (Supabase SQL Editor, 순서대로 1회)
`017_ships_sort_hidden` → `018_bwts_log_analysis` → `019_bwts_reviews` → `020_env_views` → `021_env_readonly`.
013~016 재실행 금지 규칙은 그대로. 017~021 은 전부 재실행 가능.

### 파이프라인 (로컬 PC)
- 사용자 환경변수: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service_role, anon 아님).
- 월간: `pipelines\bwts_log\BWTS_monthly_update.bat` (= `python run.py -v`). 백필: 인자 `2024-2026`.
- 결과 확인: 웹 🧪 BWTS 로그 탭, 🏠 종합 탭. 계약 JSON: `G:\...\공무팀 AI\AI 대쉬보드 (공무팀)\환경\data\`.
- 재검토: Claude Code 에서 `/bwts-review`.

### 이원우님(공무팀 Dash)에게 전달할 것
`contracts/env_summary.schema.md` 한 장. Dash 는 G드라이브 JSON 만 읽으면 된다.
