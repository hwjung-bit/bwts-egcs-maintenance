/**
 * SupabaseDriveIndex.gs
 * 이 스크립트가 만드는 작업 폴더(YYYY-MM-DD 제목)를 Supabase
 * drive_folders 테이블에 색인한다. GitHub Pages 대시보드의
 * 수리이력 📁 버튼이 이 색인을 보고 폴더를 바로 연다.
 *
 * 이 스크립트는 사용자 계정 권한으로 돌므로 서비스 계정 공유가
 * 필요 없다 (조직 정책상 외부 계정 초대가 막혀 있음).
 *
 * 사용법:
 *   1. 아래 SERVICE_KEY 에 service_role 키를 붙여넣고 저장
 *   2. setupAll 실행 (권한 승인 → 색인 → 매일 07시 트리거)
 *   3. 실행 끝나면 SERVICE_KEY 를 다시 비우고 저장
 *      (키는 스크립트 속성에 남아 트리거가 계속 사용)
 */

// ── 여기만 채우면 됨 ──────────────────────────────────
var SERVICE_KEY = '';   // ← service_role 키 붙여넣기
var SUPA_URL    = 'https://ivsjskywdtsnoxhnozcd.supabase.co';
// ─────────────────────────────────────────────────────

var SUPA_URL_KEY = 'SUPABASE_URL';
var SUPA_KEY_KEY = 'SUPABASE_SERVICE_KEY';

/** 폴더명 앞머리의 날짜. "2026-07-21 ..." / "2026.07.21 ..." 둘 다. */
var FOLDER_DATE_RE = /^(\d{4})[-.](\d{2})[-.](\d{2})\s*(.*)$/;

/**
 * 한 번만 실행하면 되는 진입점.
 * 키 저장 → 전체 색인 → 매일 07시 트리거 설치.
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
  var key = p.getProperty(SUPA_KEY_KEY) ||
            String(SERVICE_KEY || '').trim();
  if (!url || !key) {
    throw new Error('SERVICE_KEY 를 채우고 setupAll 을 먼저 실행하세요.');
  }
  return { url: url.replace(/\/+$/, ''), key: key };
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
        headers: {
          apikey: cfg.key,
          Authorization: 'Bearer ' + cfg.key,
          Prefer: 'resolution=merge-duplicates,return=minimal',
        },
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
    var f = it.next();
    var name = f.getName();
    var m = FOLDER_DATE_RE.exec(name);
    rows.push({
      id: f.getId(),
      ship_code: shipCode,
      system: system,
      folder_date: m ? (m[1] + '-' + m[2] + '-' + m[3]) : null,
      title: m ? m[4].trim() : name,
      name: name,
      url: 'https://drive.google.com/drive/folders/' + f.getId(),
      parent_id: shipFolder.getId(),
    });
  }
  return rows;
}

/** 두 리포트 트리 전체를 색인한다. 트리거로 매일 도는 진입점. */
function indexDriveFolders() {
  var p = PropertiesService.getScriptProperties();
  var roots = {
    BWTS: p.getProperty(BWTS_ROOT_KEY) || BWTS_ROOT_FALLBACK,
    EGCS: p.getProperty(EGCS_ROOT_KEY) || EGCS_ROOT_FALLBACK,
  };

  var rows = [];
  Object.keys(roots).forEach(function (system) {
    var root = DriveApp.getFolderById(roots[system]);
    Object.keys(SHIP_FOLDER).forEach(function (code) {
      var it = root.getFoldersByName(SHIP_FOLDER[code]);
      if (!it.hasNext()) return;
      rows = rows.concat(indexShipFolder_(it.next(), code, system));
    });
  });

  var sent = supaUpsertFolders_(rows);
  Logger.log('drive_folders upsert: ' + sent + '건');
  return sent;
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
  var cfg = supaCfg_();
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'patch',
    contentType: 'application/json',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=minimal',
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabase PATCH ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 200));
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

/** 색인에서 이미 있는 폴더를 찾는다. 없으면 null. */
function findIndexedFolder_(req) {
  var rows = supaGet_('drive_folders?select=id,folder_date,title' +
    '&ship_code=eq.' + encodeURIComponent(req.ship_code) +
    '&system=eq.' + encodeURIComponent(req.system));
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
  var created = processCreateRequests_();
  var trashed = processFolderTrash();
  return { created: created, trashed: trashed };
}

/** 폴더 생성 요청 처리. */
function processCreateRequests_() {
  var reqs = supaGet_('folder_requests?select=*&status=eq.pending' +
                      '&order=created_at.asc&limit=50');
  if (!reqs.length) return 0;

  var done = 0;
  reqs.forEach(function (req) {
    var patch = { processed_at: new Date().toISOString() };
    try {
      var hit = findIndexedFolder_(req);
      if (hit) {
        patch.status = 'linked';
        patch.folder_id = hit.id;
      } else {
        // 정확 이름 find-or-create — 기존 수집 로직과 같은 경로
        var id = getEventFolder_(req.system, req.ship_code,
                                 req.req_date, req.title);
        patch.status = 'created';
        patch.folder_id = id;
        var shipId = getShipFolder_(req.system, req.ship_code);
        supaUpsertFolders_(indexShipFolder_(
          DriveApp.getFolderById(shipId), req.ship_code, req.system));
      }
      done++;
    } catch (e) {
      patch.status = 'error';
      patch.note = String(e.message).slice(0, 300);
    }
    supaPatch_('folder_requests?repair_id=eq.' +
               encodeURIComponent(req.repair_id), patch);
  });

  Logger.log('folder_requests 처리: ' + done + '/' + reqs.length);
  return done;
}

function supaDelete_(path) {
  var cfg = supaCfg_();
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + path, {
    method: 'delete',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'return=minimal',
    },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() >= 300) {
    throw new Error('Supabase DELETE ' + res.getResponseCode() + ': ' +
                    res.getContentText().slice(0, 200));
  }
}

/**
 * 삭제된 수리이력의 작업폴더를 휴지통으로 보낸다.
 * 휴지통이므로 Drive 에서 복구 가능하고, 색인 행만 함께 지운다.
 * 선박 폴더는 프론트가 요청을 만들지 않지만, 여기서도 한 번 더 막는다.
 */
function processFolderTrash() {
  var reqs = supaGet_('folder_trash_requests?select=*&status=eq.pending' +
                      '&order=created_at.asc&limit=50');
  if (!reqs.length) return 0;

  var shipNames = {};
  Object.keys(SHIP_FOLDER).forEach(function (c) {
    shipNames[SHIP_FOLDER[c]] = 1;
  });

  var done = 0;
  reqs.forEach(function (req) {
    var patch = { processed_at: new Date().toISOString() };
    try {
      var f = DriveApp.getFolderById(req.folder_id);
      if (shipNames[f.getName()]) {
        throw new Error('선박 폴더는 삭제 대상이 아님: ' + f.getName());
      }
      f.setTrashed(true);
      supaDelete_('drive_folders?id=eq.' +
                  encodeURIComponent(req.folder_id));
      patch.status = 'trashed';
      done++;
    } catch (e) {
      patch.status = 'error';
      patch.note = String(e.message).slice(0, 300);
    }
    supaPatch_('folder_trash_requests?folder_id=eq.' +
               encodeURIComponent(req.folder_id), patch);
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
