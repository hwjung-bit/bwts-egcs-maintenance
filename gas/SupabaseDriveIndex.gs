/**
 * SupabaseDriveIndex.gs
 * 이 스크립트가 만드는 작업 폴더(YYYY-MM-DD 제목)를 Supabase
 * drive_folders 테이블에 색인한다. GitHub Pages 대시보드의
 * 수리이력 📁 버튼이 이 색인을 보고 폴더를 바로 연다.
 *
 * 이 스크립트는 사용자 계정 권한으로 돌므로 서비스 계정 공유가
 * 필요 없다 (조직 정책상 외부 계정 초대가 막혀 있음).
 * 바꿔 말하면 소유자 전권으로 Drive 를 만지므로, 삭제 경로에는
 * 아래 trashGuard_ 3중 검사가 반드시 걸려 있어야 한다.
 *
 * 폴더 요청 큐(아래) 는 msg_id 가 있으면 원본 메일 스레드의 첨부파일까지
 * 작업폴더에 실제로 저장한다 — GmailApp 사용하므로 최초 실행 시
 * Gmail 읽기 권한 승인이 추가로 뜬다.
 *
 * 사용법:
 *   1. 아래 SERVICE_KEY 에 service_role 키를 붙여넣고 저장
 *   2. setupAll 실행 (권한 승인 → 색인 → 트리거 설치)
 *   3. 실행 끝나면 SERVICE_KEY 를 다시 비우고 저장
 *      (키는 스크립트 속성에 남아 트리거가 계속 사용)
 *
 * 배포 시 주의 — 스코프가 늘어나면(예: GmailApp 추가) 기존 시간 기반
 * 트리거는 소유자가 에디터에서 1회 수동 실행해 재승인하기 전까지
 * authorization 오류로 실패한다. 그동안 생성·삭제 큐가 둘 다 멈춘다.
 * 배포 직후 processFolderRequests 를 에디터에서 한 번 실행할 것.
 */

// ── setupAll 실행 시에만 채운다. 실행 후 다시 비울 것 ─────
var SERVICE_KEY = '';   // ← service_role 키 붙여넣기
var SUPA_URL    = 'https://ivsjskywdtsnoxhnozcd.supabase.co';
// ─────────────────────────────────────────────────────

var SUPA_URL_KEY = 'SUPABASE_URL';
var SUPA_KEY_KEY = 'SUPABASE_SERVICE_KEY';

/** 폴더명 앞머리의 날짜. "2026-07-21 ..." / "2026.07.21 ..." 둘 다. */
var FOLDER_DATE_RE = /^(\d{4})[-.](\d{2})[-.](\d{2})\s*(.*)$/;

/** 큐 재시도 상한. 넘으면 status='error' 로 두고 사람을 기다린다. */
var MAX_ATTEMPTS = 3;

/** 선점 후 이 시간이 지나면 죽은 실행으로 보고 회수한다 (분). */
var CLAIM_STALE_MIN = 15;

/** GAS 실행 한도는 6분. 여유를 두고 스스로 멈춘다 (밀리초). */
var TIME_BUDGET_MS = 4 * 60 * 1000;

/** 색인 진행 커서 — 한도에 걸리면 다음 실행이 이어받는다. */
var INDEX_CURSOR_KEY = 'DRIVE_INDEX_CURSOR';

/**
 * 한 번만 실행하면 되는 진입점.
 * 키 저장 → 전체 색인 → 트리거 설치.
 */
function setupAll() {
  var saved = saveSupabaseCreds_();
  var n = indexDriveFolders();
  var trg = installDriveIndexTrigger();
  var trg2 = installFolderRequestTrigger();
  var msg = saved + ' / 색인 ' + n + '건 / 색인 트리거: ' + trg +
            ' / 큐 트리거: ' + trg2;
  Logger.log(msg);
  return msg;
}

/** SERVICE_KEY 를 스크립트 속성에 저장. 이미 있으면 그대로 둔다. */
function saveSupabaseCreds_() {
  var p = PropertiesService.getScriptProperties();
  var key = String(SERVICE_KEY || '').trim();

  if (!key) {
    if (p.getProperty(SUPA_KEY_KEY)) return '키 이미 저장됨';
    throw new Error('SERVICE_KEY 를 채운 뒤 실행하세요.');
  }
  p.setProperties({
    SUPABASE_URL: SUPA_URL,
    SUPABASE_SERVICE_KEY: key,
  });
  return '키 저장';
}

function supaCfg_() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty(SUPA_URL_KEY) || SUPA_URL;
  // 소스 리터럴은 폴백으로 읽지 않는다. 실수로 키를 남긴 채 커밋해도
  // 그게 실제로 쓰이지는 않도록, 런타임은 스크립트 속성만 신뢰한다.
  var key = p.getProperty(SUPA_KEY_KEY);
  if (!url || !key) {
    throw new Error('SERVICE_KEY 를 채우고 setupAll 을 먼저 실행하세요.');
  }
  return { url: url.replace(/\/+$/, ''), key: key };
}

function supaHeaders_(cfg, prefer) {
  return {
    apikey: cfg.key,
    Authorization: 'Bearer ' + cfg.key,
    Prefer: prefer,
  };
}

/** drive_folders 에 upsert. 200건씩 끊어 보낸다. */
function supaUpsertFolders_(rows) {
  if (!rows.length) return 0;
  var cfg = supaCfg_();
  var sent = 0;
  for (var i = 0; i < rows.length; i += 200) {
    var chunk = rows.slice(i, i + 200);
    var res = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/drive_folders?on_conflict=id', {
        method: 'post',
        contentType: 'application/json',
        headers: supaHeaders_(
          cfg, 'resolution=merge-duplicates,return=minimal'),
        payload: JSON.stringify(chunk),
        muteHttpExceptions: true,
      });
    var code = res.getResponseCode();
    if (code >= 300) {
      throw new Error('Supabase ' + code + ': ' +
                      res.getContentText().slice(0, 300));
    }
    sent += chunk.length;
  }
  return sent;
}

/** 한 선박 폴더 아래의 작업 폴더들을 행으로 만든다. */
function indexShipFolder_(shipFolder, shipCode, system) {
  var rows = [];
  var it = shipFolder.getFolders();
  while (it.hasNext()) {
    rows.push(folderRow_(it.next(), shipCode, system, shipFolder.getId()));
  }
  return rows;
}

/** 폴더 하나를 drive_folders 행으로. */
function folderRow_(f, shipCode, system, parentId) {
  var name = f.getName();
  var m = FOLDER_DATE_RE.exec(name);
  return {
    id: f.getId(),
    ship_code: shipCode,
    system: system,
    folder_date: m ? (m[1] + '-' + m[2] + '-' + m[3]) : null,
    title: m ? m[4].trim() : name,
    name: name,
    url: 'https://drive.google.com/drive/folders/' + f.getId(),
    parent_id: parentId,
  };
}

function driveRoots_() {
  var p = PropertiesService.getScriptProperties();
  return {
    BWTS: p.getProperty(BWTS_ROOT_KEY) || BWTS_ROOT_FALLBACK,
    EGCS: p.getProperty(EGCS_ROOT_KEY) || EGCS_ROOT_FALLBACK,
  };
}

/**
 * 두 리포트 트리 전체를 색인한다. 트리거로 매일 도는 진입점.
 *
 * 선박 단위로 즉시 upsert 하고 진행 커서를 남긴다. 예전에는 24척 ×
 * 2시스템을 전부 메모리에 모아 마지막에 한 번만 보냈기 때문에, 6분
 * 한도에 걸리면 아무것도 저장되지 않은 채 조용히 끝났다.
 */
function indexDriveFolders() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('색인: 다른 실행이 진행 중 — 건너뜀');
    return 0;
  }
  try {
    var started = Date.now();
    var p = PropertiesService.getScriptProperties();
    var roots = driveRoots_();
    var done = {};
    try {
      done = JSON.parse(p.getProperty(INDEX_CURSOR_KEY) || '{}');
    } catch (e) {
      done = {};
    }

    var sent = 0;
    var exhausted = false;

    Object.keys(roots).forEach(function (system) {
      if (exhausted) return;
      var root = DriveApp.getFolderById(roots[system]);

      Object.keys(SHIP_FOLDER).forEach(function (code) {
        if (exhausted) return;
        var mark = system + ':' + code;
        if (done[mark]) return;

        if (Date.now() - started > TIME_BUDGET_MS) {
          exhausted = true;
          return;
        }

        var it = root.getFoldersByName(SHIP_FOLDER[code]);
        if (!it.hasNext()) { done[mark] = 1; return; }

        sent += supaUpsertFolders_(
          indexShipFolder_(it.next(), code, system));
        done[mark] = 1;
      });
    });

    if (exhausted) {
      p.setProperty(INDEX_CURSOR_KEY, JSON.stringify(done));
      Logger.log('drive_folders upsert: ' + sent +
                 '건 (시간 한도 — 다음 실행이 이어받음)');
    } else {
      p.deleteProperty(INDEX_CURSOR_KEY);
      Logger.log('drive_folders upsert: ' + sent + '건 (전체 완료)');
    }
    return sent;
  } finally {
    lock.releaseLock();
  }
}

/** 매일 07시 자동 갱신. */
function installDriveIndexTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'indexDriveFolders';
  });
  if (exists) return '이미 설치됨';
  ScriptApp.newTrigger('indexDriveFolders')
    .timeBased().everyDays(1).atHour(7).create();
  return '설치 완료 — 매일 07시';
}

/* ===================================================================
 * 폴더 요청 큐 — 대시보드에서 수리이력으로 옮긴 건의 작업 폴더를
 * 찾거나 만든다. 폴더를 만들기 전에 색인을 먼저 조회하므로 이미
 * 있는 폴더는 다시 만들지 않는다.
 * =================================================================== */

var REQ_SIM_MIN = 0.35;   // 프론트와 동일한 제목 유사도 기준
var REQ_DAY_GAP = 3;      // 프론트와 동일한 날짜 허용 범위

function supaGet_(path) {
  var cfg = supaCfg_();
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'get',
    headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabase GET ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 200));
  }
  return JSON.parse(res.getContentText());
}

function supaPatch_(path, body) {
  supaPatchReturning_(path, body, false);
}

/**
 * PATCH. want 가 true 면 실제로 갱신된 행을 돌려준다.
 * 큐 선점(claim)에 쓴다 — 필터에 status=eq.pending 을 걸고 빈 배열이
 * 오면 다른 실행이 먼저 가져간 것이다.
 */
function supaPatchReturning_(path, body, want) {
  var cfg = supaCfg_();
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'patch',
    contentType: 'application/json',
    headers: supaHeaders_(
      cfg, want ? 'return=representation' : 'return=minimal'),
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabase PATCH ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 200));
  }
  if (!want) return null;
  var txt = res.getContentText();
  return txt ? JSON.parse(txt) : [];
}

function supaDelete_(path) {
  var cfg = supaCfg_();
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'delete',
    headers: supaHeaders_(cfg, 'return=minimal'),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabase DELETE ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 200));
  }
}

/**
 * 큐에서 처리할 행을 선점한다.
 *
 * 1. 죽은 선점 회수 — processing 인데 locked_at 이 오래된 행
 * 2. pending 조회
 * 3. 행마다 status=eq.pending 조건부 PATCH → 이긴 것만 가져간다
 *
 * 예전에는 SELECT 만 하고 바로 작업해서, 15분 트리거와 수동 실행이
 * 겹치면 같은 요청으로 같은 이름 폴더를 두 번 만들었다.
 */
function claimRequests_(table, keyCol, limit) {
  var staleBefore = new Date(
    Date.now() - CLAIM_STALE_MIN * 60000).toISOString();

  // 죽은 선점을 되돌릴 때도 attempts 를 올린다. 그러지 않으면 실행을
  // 매번 죽이는 요청(타임아웃 등)이 영원히 회수·재시도를 반복한다.
  var stale = supaGet_(table + '?select=*&status=eq.processing' +
                       '&locked_at=lt.' + encodeURIComponent(staleBefore));
  stale.forEach(function (req) {
    var tries = (req.attempts || 0) + 1;
    try {
      supaPatch_(table + '?' + keyCol + '=eq.' +
                 encodeURIComponent(req[keyCol]), {
        status: tries >= MAX_ATTEMPTS ? 'error' : 'pending',
        attempts: tries,
        locked_at: null,
        note: '선점 후 응답 없음 — 회수 (시도 ' + tries + ')',
      });
    } catch (e) {
      Logger.log('선점 회수 실패 (' + req[keyCol] + '): ' + e.message);
    }
  });

  var pending = supaGet_(table + '?select=*&status=eq.pending' +
                         '&order=created_at.asc&limit=' + limit);
  var mine = [];
  pending.forEach(function (req) {
    var won = supaPatchReturning_(
      table + '?' + keyCol + '=eq.' +
      encodeURIComponent(req[keyCol]) + '&status=eq.pending',
      { status: 'processing', locked_at: new Date().toISOString() },
      true);
    if (won && won.length) mine.push(won[0]);
  });
  return mine;
}

/**
 * 처리 결과를 기록한다. 실패면 재시도 여지를 남긴다.
 * MAX_ATTEMPTS 를 소진해야 'error' 로 굳는다 — 예전에는 첫 실패가
 * 곧 종착역이라 실패 건을 아무도 다시 보지 않았다.
 */
function finishRequest_(table, keyCol, req, patch, err) {
  var body = patch || {};
  body.processed_at = new Date().toISOString();
  body.locked_at = null;

  if (err) {
    var tries = (req.attempts || 0) + 1;
    body.attempts = tries;
    body.note = String(err.message || err).slice(0, 300);
    body.status = tries >= MAX_ATTEMPTS ? 'error' : 'pending';
  }

  try {
    supaPatch_(table + '?' + keyCol + '=eq.' +
               encodeURIComponent(req[keyCol]), body);
  } catch (e) {
    // 결과 기록 실패가 나머지 큐 처리를 멈추면 안 된다.
    // 선점은 CLAIM_STALE_MIN 후 자동 회수되므로 유실되지 않는다.
    Logger.log('결과 기록 실패 (' + req[keyCol] + '): ' + e.message);
  }
}

/** 제목 정규화 — 프론트 normTitle 과 같은 규칙. */
function reqNorm_(s) {
  return String(s == null ? '' : s).toUpperCase()
    .replace(/\b(RE|FW|FWD)\s*:/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/[^0-9A-Z가-힣]+/g, '');
}

/** 짧은 쪽 기준 trigram 겹침 — 프론트 titleOverlap 과 같은 규칙. */
function reqOverlap_(a, b) {
  if (!a || !b) return 0;
  if (a.indexOf(b) >= 0 || b.indexOf(a) >= 0) return 1;
  function tri(s) {
    var o = {};
    for (var i = 0; i + 3 <= s.length; i++) o[s.substring(i, i + 3)] = 1;
    return o;
  }
  var ta = tri(a), tb = tri(b);
  var ka = Object.keys(ta), kb = Object.keys(tb);
  if (!ka.length || !kb.length) return 0;
  var hit = 0;
  ka.forEach(function (k) { if (tb[k]) hit++; });
  return hit / Math.min(ka.length, kb.length);
}

function reqDayGap_(a, b) {
  if (!a || !b) return 999;
  return Math.abs((new Date(a) - new Date(b)) / 86400000);
}

/**
 * 이번 회차에 필요한 (선박, 시스템) 조합의 색인을 한 번에 받아둔다.
 * 예전에는 요청 1건마다 전체를 다시 GET 해서(N+1), 50건이면 왕복이
 * 50회였다. 15분 트리거라 하루 96회 반복된다.
 */
function loadFolderIndex_(reqs) {
  var ships = {}, systems = {};
  reqs.forEach(function (r) {
    ships[r.ship_code] = 1;
    systems[r.system] = 1;
  });
  var shipList = Object.keys(ships), sysList = Object.keys(systems);
  if (!shipList.length) return {};

  var rows = supaGet_(
    'drive_folders?select=id,folder_date,title,ship_code,system' +
    '&ship_code=in.(' + shipList.map(encodeURIComponent).join(',') + ')' +
    '&system=in.(' + sysList.map(encodeURIComponent).join(',') + ')');

  var by = {};
  rows.forEach(function (f) {
    var k = f.ship_code + '|' + f.system;
    (by[k] = by[k] || []).push(f);
  });
  return by;
}

/** 색인에서 이미 있는 폴더를 찾는다. 없으면 null. */
function findIndexedFolder_(req, index) {
  var rows = index[req.ship_code + '|' + req.system] || [];
  var want = reqNorm_(req.title);
  var sameDay = [], best = null, bestSim = -1;

  rows.forEach(function (f) {
    if (reqDayGap_(f.folder_date, req.req_date) > REQ_DAY_GAP) return;
    if (f.folder_date === req.req_date) sameDay.push(f);
    var sim = reqOverlap_(want, reqNorm_(f.title));
    if (f.folder_date === req.req_date) sim += 0.15;
    if (sim > bestSim) { bestSim = sim; best = f; }
  });

  if (bestSim >= REQ_SIM_MIN) return best;
  if (sameDay.length === 1) return sameDay[0];
  return null;
}

/** 생성·삭제 큐를 모두 처리한다. 트리거로 15분마다 도는 진입점. */
function processFolderRequests() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(0)) {
    Logger.log('큐: 다른 실행이 진행 중 — 건너뜀');
    return { created: 0, trashed: 0 };
  }
  try {
    // 생성 쪽 장애가 삭제 큐까지 세우면 안 된다. 따로 감싼다.
    var created = 0, trashed = 0;
    try {
      created = processCreateRequests_();
    } catch (e) {
      Logger.log('생성 큐 실패: ' + e.message);
    }
    try {
      trashed = processFolderTrash();
    } catch (e) {
      Logger.log('삭제 큐 실패: ' + e.message);
    }
    var uploaded = 0;
    try {
      uploaded = processUploadRequests_();
    } catch (e) {
      Logger.log('업로드 큐 실패: ' + e.message);
    }
    return { created: created, trashed: trashed, uploaded: uploaded };
  } finally {
    lock.releaseLock();
  }
}

/** 폴더 생성 요청 처리. */
function processCreateRequests_() {
  var reqs = claimRequests_('folder_requests', 'repair_id', 50);
  if (!reqs.length) return 0;

  var index = loadFolderIndex_(reqs);
  var done = 0;

  reqs.forEach(function (req) {
    var patch = {};
    try {
      // 선점과 실제 작업 사이에 수리이력이 지워졌을 수 있다. 그대로
      // 진행하면 존재하지 않는 건의 폴더를 만들어 고아로 남는다.
      // (folder_requests 는 repairs 에 ON DELETE CASCADE 로 묶여 있어
      //  프론트의 status='cancelled' 표시도 함께 사라진다.)
      var alive = supaGet_('repairs?select=id&id=eq.' +
                           encodeURIComponent(req.repair_id));
      if (!alive.length) {
        // 행이 CASCADE 로 이미 사라졌으면 이 PATCH 는 0행이라 무해하다.
        // 살아남은 경우(015 적용 전 데이터)에는 processing 에 갇히지 않게
        // 명시적으로 닫아준다.
        finishRequest_('folder_requests', 'repair_id', req,
                       { status: 'cancelled',
                         note: '수리이력이 삭제됨' }, null);
        Logger.log('수리이력 없음 — 건너뜀: ' + req.repair_id);
        return;
      }

      var hit = findIndexedFolder_(req, index);
      if (hit) {
        patch.status = 'linked';
        patch.folder_id = hit.id;
      } else {
        // 정확 이름 find-or-create — 기존 수집 로직과 같은 경로
        var id = getEventFolder_(req.system, req.ship_code,
                                 req.req_date, req.title);
        patch.status = 'created';
        patch.folder_id = id;
        // 만든 폴더 1행만 색인한다. 선박 폴더 전체를 다시 나열하면
        // 50건 처리 시 Drive 나열이 50회라 6분 한도를 넘긴다.
        var shipId = getShipFolder_(req.system, req.ship_code);
        supaUpsertFolders_([folderRow_(
          DriveApp.getFolderById(id), req.ship_code, req.system, shipId)]);
      }
      if (req.msg_id) saveRequestAttachments_(req, patch.folder_id);
      finishRequest_('folder_requests', 'repair_id', req, patch, null);
      done++;
    } catch (e) {
      finishRequest_('folder_requests', 'repair_id', req, null, e);
    }
  });

  Logger.log('folder_requests 처리: ' + done + '/' + reqs.length);
  return done;
}

/**
 * 원본 Gmail 스레드의 첨부파일을 작업폴더에 저장하고,
 * repairs.attachments 에 url 을 채운다.
 *
 * 스레드 전체를 도는 이유: source_msg_id 는 스레드 첫 메일을 가리키는데
 * 서비스리포트는 대개 나중 답장에 붙는다. 첫 메일만 열면 (대개 비어
 * 있는) 첨부를 저장하게 된다.
 *
 * 병합하는 이유: 프론트가 넣어둔 {name} 목록과 사람이 수동으로 붙인
 * 링크를 덮어쓰면 안 된다. 이름이 같으면 url 만 채우고, 없던 것만 더한다.
 *
 * 실패해도 폴더 요청 자체는 성공 처리해야 하므로 여기서 삼킨다.
 */
function saveRequestAttachments_(req, folderId) {
  try {
    var msg = GmailApp.getMessageById(req.msg_id);
    if (!msg) return;

    var atts = [];
    msg.getThread().getMessages().forEach(function (m) {
      m.getAttachments({ includeInlineImages: false })
        .forEach(function (a) { atts.push(a); });
    });
    if (!atts.length) return;

    var folder = DriveApp.getFolderById(folderId);
    var urlByName = {};
    var rules = attachRules_();
    var skipped = [];
    atts.forEach(function (att) {
      var name = att.getName() || 'file';
      if (urlByName[name]) return;   // 스레드 내 같은 이름 중복
      // 필요한 것만 — 스레드 전체를 돌면 답장마다 재첨부된 견적·서명
      // 이미지·LOG DATA PDF 까지 폴더에 쌓인다 (2026-09-01 이전 동작).
      // 규칙은 contracts/attachment_rules.json. 이미 저장된 파일은 그대로.
      if (!keepAttachment_(name, att.getSize(), rules)) {
        skipped.push(name);
        return;
      }
      if (Object.keys(urlByName).length >= (rules.max_files_per_folder || 20)) {
        skipped.push(name);
        return;
      }
      var existing = folder.getFilesByName(name);
      var file = existing.hasNext()
        ? existing.next()
        : folder.createFile(att.copyBlob()).setName(name);
      urlByName[name] = file.getUrl();
    });

    var rows = supaGet_('repairs?select=attachments&id=eq.' +
                        encodeURIComponent(req.repair_id));
    var prev = [];
    if (rows.length) {
      try {
        prev = JSON.parse(rows[0].attachments || '[]');
      } catch (e) {
        prev = [];
      }
    }
    if (!Array.isArray(prev)) prev = [];

    var merged = prev.map(function (it) {
      var name = it && it.name ? it.name : String(it || '');
      if (urlByName[name] && !(it && it.url)) {
        return { name: name, url: urlByName[name] };
      }
      return it;
    });
    var known = {};
    merged.forEach(function (it) {
      if (it && it.name) known[it.name] = 1;
    });
    Object.keys(urlByName).forEach(function (name) {
      if (!known[name]) merged.push({ name: name, url: urlByName[name] });
    });

    supaPatch_('repairs?id=eq.' + encodeURIComponent(req.repair_id),
               { attachments: JSON.stringify(merged) });
    Logger.log('첨부 저장: ' + req.repair_id + ' ' +
               Object.keys(urlByName).length + '건, 제외 ' + skipped.length +
               (skipped.length ? ' (' + skipped.slice(0, 5).join(', ') + ')' : ''));
  } catch (e) {
    Logger.log('첨부 저장 실패 (' + req.repair_id + '): ' + e.message);
  }
}

/**
 * 휴지통 가드 — 이 함수를 통과하지 못하면 절대 지우지 않는다.
 *
 * 이 스크립트는 소유자 전권으로 돌고, folder_trash_requests 는
 * @ekmtc.com 계정이면 누구나 임의 folder_id 를 INSERT 할 수 있다.
 * 예전에는 "이름이 선박 폴더와 같지 않다"만 확인해서, 잘못된 id 하나로
 * 공유드라이브의 무관한 폴더(루트 포함)를 통째로 날릴 수 있었다.
 *
 * 세 가지를 모두 만족해야 한다:
 *   1. 이름이 작업폴더 형식(YYYY-MM-DD 제목)일 것
 *   2. 부모가 요청의 ship_code 에 해당하는 선박 폴더일 것
 *   3. 그 선박 폴더가 요청의 system 리포트 루트 바로 아래일 것
 */
function trashGuard_(folder, req) {
  var name = folder.getName();
  if (!FOLDER_DATE_RE.test(name)) {
    throw new Error('작업폴더 형식이 아님: ' + name);
  }

  var wantShip = SHIP_FOLDER[req.ship_code];
  if (!wantShip) {
    throw new Error('알 수 없는 선박 코드: ' + req.ship_code);
  }

  var parents = folder.getParents();
  if (!parents.hasNext()) throw new Error('부모 없음: ' + name);
  var shipFolder = parents.next();
  if (parents.hasNext()) {
    throw new Error('부모가 둘 이상: ' + name);
  }
  if (shipFolder.getName() !== wantShip) {
    throw new Error('선박 폴더 불일치: ' + shipFolder.getName() +
                    ' ≠ ' + wantShip);
  }

  var rootId = driveRoots_()[req.system];
  if (!rootId) throw new Error('알 수 없는 시스템: ' + req.system);

  var gps = shipFolder.getParents();
  var underRoot = false;
  while (gps.hasNext()) {
    if (gps.next().getId() === rootId) { underRoot = true; break; }
  }
  if (!underRoot) {
    throw new Error('리포트 루트 밖: ' + shipFolder.getName());
  }
}

/**
 * 삭제된 수리이력의 작업폴더를 휴지통으로 보낸다.
 * 휴지통이므로 Drive 에서 복구 가능하고, 색인 행만 함께 지운다.
 */
function processFolderTrash() {
  var reqs = claimRequests_('folder_trash_requests', 'folder_id', 50);
  if (!reqs.length) return 0;

  var done = 0;
  reqs.forEach(function (req) {
    try {
      var f = DriveApp.getFolderById(req.folder_id);
      trashGuard_(f, req);
      f.setTrashed(true);
      supaDelete_('drive_folders?id=eq.' +
                  encodeURIComponent(req.folder_id));
      finishRequest_('folder_trash_requests', 'folder_id', req,
                     { status: 'trashed' }, null);
      done++;
    } catch (e) {
      finishRequest_('folder_trash_requests', 'folder_id', req, null, e);
    }
  });

  Logger.log('folder_trash 처리: ' + done + '/' + reqs.length);
  return done;
}

/** 15분마다 큐 처리. 에디터에서 1회 실행. */
function installFolderRequestTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'processFolderRequests';
  });
  if (exists) return '이미 설치됨';
  ScriptApp.newTrigger('processFolderRequests')
    .timeBased().everyMinutes(15).create();
  return '설치 완료 — 15분마다';
}


/* ═══════════════════════════════════════════════════════════════
 * 첨부 필터 — contracts/attachment_rules.json (공개 리포, 1시간 캐시)
 * 규칙 순서: drop → keep(이름) → keep(확장자, 이미지는 크기) → 제외
 * ═══════════════════════════════════════════════════════════════ */
var ATTACH_RULES_URL =
  'https://raw.githubusercontent.com/hwjung-bit/bwts-egcs-maintenance/main/contracts/attachment_rules.json';
var ATTACH_RULES_FALLBACK = {
  drop_name_patterns: ['EVENTLOG', 'DATALOG', 'DATAREPORT', 'OPERATIONTIME', 'TOTALLOG',
                       'LOG\\s*DATA', 'BWRB', '^image\\d*\\.', '^outlook-', 'logo', 'signature',
                       '\\.ics$', '\\.p7s$', '\\.vcf$', '\\.htm$', '\\.html$', '\\.eml$'],
  keep_name_patterns: ['REPORT', '\\bSR\\b', '보고서', '견적', 'QUOT', 'INVOICE', 'CERT', '성적서',
                       'CALIBRATION', '검교정', 'MANUAL', 'DRAWING'],
  keep_extensions: ['pdf', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'zip', 'jpg', 'jpeg', 'png'],
  min_image_bytes: 200000,
  max_files_per_folder: 20,
};

function attachRules_() {
  var cache = CacheService.getScriptCache();
  var hit = cache.get('ATTACH_RULES');
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* fall through */ }
  }
  try {
    var res = UrlFetchApp.fetch(ATTACH_RULES_URL, { muteHttpExceptions: true });
    if (res.getResponseCode() === 200) {
      var txt = res.getContentText();
      JSON.parse(txt);                       // validate before caching
      cache.put('ATTACH_RULES', txt, 3600);
      return JSON.parse(txt);
    }
  } catch (e) {
    Logger.log('첨부 규칙 로드 실패 — 내장 기본값 사용: ' + e.message);
  }
  return ATTACH_RULES_FALLBACK;
}

function keepAttachment_(name, bytes, rules) {
  var n = String(name || '');
  var test = function (pats) {
    return (pats || []).some(function (p) {
      try { return new RegExp(p, 'i').test(n); } catch (e) { return false; }
    });
  };
  if (test(rules.drop_name_patterns)) return false;
  if (test(rules.keep_name_patterns)) return true;
  var m = /\.([A-Za-z0-9]+)$/.exec(n);
  var ext = m ? m[1].toLowerCase() : '';
  if ((rules.keep_extensions || []).indexOf(ext) < 0) return false;
  if (['jpg', 'jpeg', 'png', 'gif'].indexOf(ext) >= 0 &&
      (bytes || 0) < (rules.min_image_bytes || 200000)) return false;
  return true;
}


/* ═══════════════════════════════════════════════════════════════
 * 업로드 큐 — 웹에서 올린 파일(Supabase Storage)을 작업폴더로 옮긴다.
 * sql/022_upload_requests.sql. 큐 규약은 folder_requests 와 동일.
 * ═══════════════════════════════════════════════════════════════ */
var UPLOAD_BUCKET = 'repair_uploads';

function storageFetch_(path, method) {
  var cfg = supaCfg_();
  var res = UrlFetchApp.fetch(
    cfg.url + '/storage/v1/object/' + UPLOAD_BUCKET + '/' +
      path.split('/').map(encodeURIComponent).join('/'),
    { method: method || 'get', muteHttpExceptions: true,
      headers: { apikey: cfg.key, Authorization: 'Bearer ' + cfg.key } });
  var code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('storage ' + (method || 'get') + ' ' + code + ': ' +
                    res.getContentText().slice(0, 200));
  }
  return res;
}

/** repairs.attachments 에 {name,url} 을 이름 기준으로 병합한다. */
function mergeRepairAttachments_(repairId, urlByName) {
  var rows = supaGet_('repairs?select=attachments&id=eq.' + encodeURIComponent(repairId));
  var prev = [];
  if (rows.length) {
    try { prev = JSON.parse(rows[0].attachments || '[]'); } catch (e) { prev = []; }
  }
  if (!Array.isArray(prev)) prev = [];
  var known = {};
  var merged = prev.map(function (it) {
    var name = it && it.name ? it.name : String(it || '');
    known[name] = 1;
    if (urlByName[name] && !(it && it.url)) return { name: name, url: urlByName[name] };
    return it;
  });
  Object.keys(urlByName).forEach(function (name) {
    if (!known[name]) merged.push({ name: name, url: urlByName[name] });
  });
  supaPatch_('repairs?id=eq.' + encodeURIComponent(repairId),
             { attachments: JSON.stringify(merged) });
}

/** 이 수리 건의 작업폴더 id — 알려진 것 → 색인 근사 → 새로 생성 순. */
function resolveRepairFolder_(req, index) {
  var rows = supaGet_('repairs?select=id,file_url&id=eq.' + encodeURIComponent(req.repair_id));
  if (!rows.length) return null;                     // 수리이력 삭제됨
  var m = /\/folders\/([A-Za-z0-9_-]+)/.exec(rows[0].file_url || '');
  if (m) return m[1];
  var fr = supaGet_('folder_requests?select=folder_id&repair_id=eq.' +
                    encodeURIComponent(req.repair_id));
  if (fr.length && fr[0].folder_id) return fr[0].folder_id;
  var hit = findIndexedFolder_(req, index);
  if (hit) return hit.id;
  var id = getEventFolder_(req.system, req.ship_code, req.req_date, req.title);
  var shipId = getShipFolder_(req.system, req.ship_code);
  supaUpsertFolders_([folderRow_(DriveApp.getFolderById(id), req.ship_code, req.system, shipId)]);
  return id;
}

/* BWTS 검교정 자료실 업로드 (sql/024 target 컬럼).
   ROOT › <종류 폴더> › YYYY년 › 'YYYY-MM-DD SHIP' — 없으면 만든다. */
var CAL_UPLOAD_ROOT = '1YZlUbAgq2_ADwrIvtiOSmRsyUAHl9xum';  // 11. CALIBRATION 연간 검교정
var CAL_UPLOAD_DIRS = {
  bwts_cal_cert: '02. CERT',
  bwts_cal_report: '03. SERVICE REPORT',
  bwts_cal_alarm: '04. SAFETY ALARM TEST'
};
function getOrCreateChild_(parent, name) {
  var it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function resolveCalFolder_(req) {
  var dirName = CAL_UPLOAD_DIRS[req.target];
  if (!dirName) throw new Error('알 수 없는 target: ' + req.target);
  var date = String(req.req_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('req_date 없음');
  var root = DriveApp.getFolderById(CAL_UPLOAD_ROOT);
  var kind = getOrCreateChild_(root, dirName);
  var year = getOrCreateChild_(kind, date.slice(0, 4) + '년');
  return getOrCreateChild_(year, date + ' ' + req.ship_code).getId();
}

function processUploadRequests_() {
  var reqs = claimRequests_('upload_requests', 'id', 30);
  if (!reqs.length) return 0;
  var index = loadFolderIndex_(reqs);
  var done = 0;
  reqs.forEach(function (req) {
    try {
      var folderId = req.target ? resolveCalFolder_(req) : resolveRepairFolder_(req, index);
      if (!folderId) {
        finishRequest_('upload_requests', 'id', req,
                       { status: 'cancelled', note: '수리이력이 삭제됨' }, null);
        return;
      }
      var blob = storageFetch_(req.object_path, 'get').getBlob().setName(req.file_name);
      var folder = DriveApp.getFolderById(folderId);
      var existing = folder.getFilesByName(req.file_name);
      var file = existing.hasNext() ? existing.next() : folder.createFile(blob);
      if (!req.target) {
        var urlByName = {};
        urlByName[req.file_name] = file.getUrl();
        mergeRepairAttachments_(req.repair_id, urlByName);
      }
      try { storageFetch_(req.object_path, 'delete'); } catch (e) {
        Logger.log('storage 삭제 실패(무시): ' + e.message);
      }
      if (!req.target) {
        var repair = supaGet_('repairs?select=file_url&id=eq.' + encodeURIComponent(req.repair_id));
        if (repair.length && !repair[0].file_url) {
          supaPatch_('repairs?id=eq.' + encodeURIComponent(req.repair_id),
                     { file_url: 'https://drive.google.com/drive/folders/' + folderId });
        }
      }
      finishRequest_('upload_requests', 'id', req,
                     { status: 'done', folder_id: folderId, file_url: file.getUrl() }, null);
      done++;
    } catch (e) {
      finishRequest_('upload_requests', 'id', req, null, e);
    }
  });
  Logger.log('upload_requests 처리: ' + done + '/' + reqs.length);
  return done;
}
