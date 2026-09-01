# gas/ — Apps Script 소스 (프로젝트 "EGCS&BWTS 정비 관리", 190_uBRU-UaaHCbRYvFXSKOU41YkGKCU6daryZMRnPK4PyD_ztu2S7TUB)

| 파일 | 역할 | 배포 |
|---|---|---|
| `SupabaseDriveIndex.gs` | **현행.** Drive 폴더 색인, 폴더 생성/휴지통 큐, 첨부 필터, 웹 업로드 큐 | clasp 로 푸시 (아래) |
| `Code.js` | 구 GAS 웹앱 v1 (Sheets DB). `getShipFolder_`/`getEventFolder_`/`driveEnsureChildFolder_` 등 폴더 헬퍼를 SupabaseDriveIndex 가 아직 호출하므로 프로젝트에 남아 있어야 함. 웹앱·수집·스냅샷 트리거는 2026-09-01 전부 삭제됨 (트리거 0) | 참고용 사본. 여기서 수정해도 자동 반영 안 됨 |

## 배포 절차
```
mkdir gas_live && cd gas_live
echo {"scriptId":"190_uBRU-UaaHCbRYvFXSKOU41YkGKCU6daryZMRnPK4PyD_ztu2S7TUB","rootDir":""} > .clasp.json
clasp pull                       # Code.js, Index.html, JavaScript.html, Stylesheet.html, SupabaseDriveIndex.js, appsscript.json
copy ..\gas\SupabaseDriveIndex.gs SupabaseDriveIndex.js
clasp push -f                    # 6개 파일 전부 다시 올림 (다른 파일은 무변경)
```
`clasp push` 는 로컬 폴더 기준으로 프로젝트를 덮어쓴다 — **리포 `gas/` 를 clasp 루트로 쓰지 말 것** (html 3개가 없어서 프로젝트에서 지워진다).

살아 있는 트리거(2개): `processFolderRequests`(5분) · `indexDriveFolders`(매일 06:30). 스코프가 늘어나는 변경 뒤에는 에디터에서 1회 수동 실행해 재승인.
