/****************************************************************
 * BWTS · EGCS 수리관리 — Google Apps Script 웹앱
 *
 *  DB    : Google Sheets (스크립트가 자동 생성, ID는 스크립트 속성에 보관)
 *  스캔  : Google Drive (루트 폴더 + 선박별 하위폴더 자동 생성)
 *  로그인: 구글이 자동 처리 (배포 시 access=MYSELF)
 *
 *  시트(=테이블) 3개:
 *   Ships        선박 마스터
 *   Repairs      수리 이력
 *   Calibrations 검교정 항목
 ****************************************************************/

var SS_KEY = 'WORK_SS_ID';            // 스프레드시트 ID 보관 키
var ROOT_FOLDER_KEY = 'WORK_ROOT_FOLDER_ID';   // (구) 단일 루트 — 미사용 잔존
var ROOT_FOLDER_NAME = 'BWTS_EGCS_수리이력';

// 시스템별 저장 루트(공유드라이브). 스크립트 속성으로 덮어쓸 수 있고, 없으면 fallback.
var EGCS_ROOT_KEY = 'EGCS_ROOT_FOLDER_ID';
var BWTS_ROOT_KEY = 'BWTS_ROOT_FOLDER_ID';
var EGCS_ROOT_FALLBACK = '1GMA9uBDu6Oe7eo7Hnbq1SA4J9SpVIORq'; // "13 메이커 서비스"
var BWTS_ROOT_FALLBACK = '1cVPkUgFH1W1zHVLb6SiShpvuDQ8S9RBE'; // "14. SERVICE REPORT"

// 선박코드 → 루트 하위 선박폴더명 (BWTS 루트의 선대순 명명을 양쪽 루트 공통 적용)
var SHIP_FOLDER = {
  KPS: '01. KPS', KUS: '02. KUS', KKL: '03. KKL', KSG: '04. KSG', KJT: '05. KJT',
  KSH: '06. KSH', KQD: '07. KQD', KTJ: '08. KTJ', KHM: '09. KHM', KNB: '10. KNB',
  KSZ: '11. KSZ', KMB: '12. KMB', KDB: '13. KDB', KCN: '14. KCN', KJA: '15. KJA',
  KNH: '16. KNH', KMN: '17. KMN', KMU: '18. KMU', KCB: '19. KCB', KSL: '20. KSL',
  KDE: '21. KDE',
};

var SHEETS = {
  Ships: ['code', 'name', 'teu', 'bwts_maker', 'egcs_maker', 'wms', 'cems',
          'scrubber_folder', 'updatedAt'],
  Repairs: ['id', 'shipCode', 'system', 'date', 'equip', 'stage', 'symptom',
            'action', 'parts', 'cost', 'attachments', 'createdAt', 'updatedAt',
            'history', 'sourceFolderId', 'sourceMsgId', 'needsReview',
            'emailSubject', 'emailLink'],
  Calibrations: ['id', 'shipCode', 'equip', 'lastCalibration', 'intervalMonths',
                 'note', 'updatedAt', 'system', 'serial', 'model', 'certUrl'],
  Roles: ['email', 'role', 'note'],   // 접근 권한표 — 관리자가 이 시트를 직접 편집해 부여
};

// 역할 등급. 높을수록 권한이 큼. 미등록(권한표에 없음) = 0 = 접근 불가.
var ROLE_RANK = { viewer: 1, editor: 2, admin: 3 };

/* ── 웹앱 엔트리 ─────────────────────────────────────────── */
function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || '';
  // JSONP API — 로컬 HTML 대시보드에서 수정 요청 시 사용
  if (action === 'api') {
    return handleApi_(e.parameter);
  }
  if (action === 'weeklyCalAlert') {
    var result = weeklyCalAlert();
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }
  // ensureSeed_() 는 getBootstrap()에서 호출 — doGet에서 중복 제거(속도 개선)
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('EGCS&BWTS 정비 관리')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** JSONP API 핸들러 — 로컬 HTML에서 script 태그로 호출. file:// CORS 우회. */
function handleApi_(p) {
  var cb = p.callback || 'cb';
  var result;
  try {
    var method = p.method || '';
    if (method === 'updateMailStatus') {
      var patch = {};
      if (p.status !== undefined) patch.status = p.status;
      if (p.note !== undefined) patch.note = p.note;
      result = { ok: updateMailStatus(p.id, patch) };
    } else if (method === 'updateRepair') {
      var rPatch = p.patch ? JSON.parse(p.patch) : {};
      result = { ok: true, data: updateRepair(p.id, rPatch) };
    } else if (method === 'updateCalibration') {
      var cPatch = p.patch ? JSON.parse(p.patch) : {};
      result = { ok: true, data: updateCalibration(p.id, cPatch) };
    } else if (method === 'exportSnapshot') {
      exportSnapshot();
      result = { ok: true };
    } else if (method === 'getBootstrap') {
      result = { ok: true, data: getBootstrap() };
    } else if (method === 'readMailLog') {
      result = { ok: true, data: readMailLog() };
    } else {
      result = { ok: false, error: 'unknown method: ' + method };
    }
  } catch (err) {
    result = { ok: false, error: String(err).slice(0, 300) };
  }
  return ContentService.createTextOutput(
    cb + '(' + JSON.stringify(result) + ')')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* ── 스프레드시트 핸들 (없으면 생성) ───────────────────────── */
var _SS_CACHE = null; // 실행(요청)당 1회만 준비. 호출마다 헤더 재기록 방지.
function getSS_() {
  if (_SS_CACHE) return _SS_CACHE;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(SS_KEY);
  var ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('BWTS_EGCS_수리관리_DB');
    props.setProperty(SS_KEY, ss.getId());
  }
  // 시트 + 헤더 보장 (헤더가 다를 때만 1회 기록)
  Object.keys(SHEETS).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    var headers = SHEETS[name];
    var firstRow = sh.getRange(1, 1, 1, headers.length).getValues()[0];
    if (firstRow.join('') !== headers.join('')) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
      sh.setFrozenRows(1);
    }
  });
  // 기본 'Sheet1' 정리
  var def = ss.getSheetByName('시트1') || ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) {
    try { ss.deleteSheet(def); } catch (e) {}
  }
  _SS_CACHE = ss;
  return ss;
}

function sheet_(name) { return getSS_().getSheetByName(name); }

/* ── 행 <-> 객체 변환 ──────────────────────────────────────── */
function readAll_(name) {
  var sh = sheet_(name);
  var headers = SHEETS[name];
  var last = sh.getLastRow();
  if (last < 2) return [];
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  return values.map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  }).filter(function (o) { return String(o[headers[0]]) !== ''; });
}

function findRow_(name, idCol, idVal) {
  var sh = sheet_(name);
  var col = SHEETS[name].indexOf(idCol) + 1;
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var ids = sh.getRange(2, col, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(idVal)) return i + 2; // 실제 행번호
  }
  return -1;
}

function objToRow_(name, obj) {
  return SHEETS[name].map(function (h) {
    var v = obj[h];
    return v === undefined || v === null ? '' : v;
  });
}

function upsert_(name, idCol, obj) {
  var sh = sheet_(name);
  var headers = SHEETS[name];
  var rowNum = findRow_(name, idCol, obj[idCol]);
  var row = objToRow_(name, obj);
  if (rowNum > 0) {
    sh.getRange(rowNum, 1, 1, headers.length).setValues([row]);
  } else {
    sh.appendRow(row);
  }
}

/* ── 접근 권한(역할) ──────────────────────────────────────────
   배포: access=DOMAIN(ekmtc.com 로그인) + executeAs=USER_DEPLOYING.
   접속자 이메일을 권한표(Roles 시트)에서 찾아 역할을 정한다.
   - admin  : 전부 (선박·교정 마스터 + 권한 관리)
   - editor : 정비기록 추가/수정/삭제 + 스캔 업로드
   - viewer : 조회만
   - 미등록 : 접근 불가
   권한은 관리자가 DB 시트의 'Roles' 탭을 직접 편집해 부여한다. */
function normEmail_(e) { return String(e == null ? '' : e).trim().toLowerCase(); }

function getRole_() {
  var me = normEmail_(Session.getActiveUser().getEmail());
  // 활성 사용자 없음 = 웹 요청이 아님(시간기반 트리거·에디터 실행) → 소유자 권한 부여.
  // DOMAIN 접근에선 웹 요청은 항상 활성 사용자가 있으므로 우회 통로가 되지 않는다.
  if (!me) return 'admin';
  if (me === normEmail_(Session.getEffectiveUser().getEmail())) return 'admin'; // 배포자=항상 admin
  var rows = readAll_('Roles');
  for (var i = 0; i < rows.length; i++) {
    if (normEmail_(rows[i].email) === me) {
      var r = String(rows[i].role || '').trim().toLowerCase();
      return ROLE_RANK[r] ? r : '';
    }
  }
  return '';   // 권한표 미등록 → 접근 불가
}

/** 최소 역할 미달 시 예외(서버측 강제 — 화면 숨김과 무관하게 실제 보안). */
function requireRole_(min) {
  var role = getRole_();
  if ((ROLE_RANK[role] || 0) < (ROLE_RANK[min] || 99)) {
    throw new Error('권한이 없습니다. (필요: ' + min + ' / 현재: ' + (role || '미등록') + ')');
  }
  return role;
}

/** 권한표가 비어 있으면 배포자를 admin으로 1회 시드(잠금 방지). */
function ensureRolesSeed_() {
  var sh = sheet_('Roles');           // getSS_가 탭/헤더 보장
  if (sh.getLastRow() >= 2) return;   // 이미 행 있음
  var owner = Session.getEffectiveUser().getEmail();
  if (owner) upsert_('Roles', 'email',
    { email: owner, role: 'admin', note: '배포자 자동 등록' });
}

/** Roles 탭 E열에 사용법 안내를 1회 기록(읽기 로직은 A:C만 보므로 무해).
    텍스트 수정 시 ROLES_GUIDE_VER을 올리면 다음 실행 때 갱신된다. */
var ROLES_GUIDE_VER = 'v1';
function ensureRolesGuide_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('ROLES_GUIDE_VER') === ROLES_GUIDE_VER) return;
  var sh = sheet_('Roles');
  var guide = [
    ['📘 사용법  (이 열은 안내용 — 지워도 동작에는 영향 없음)'],
    [''],
    ['1) 권한 줄 사람을 왼쪽 A:C 열에 한 줄씩 추가하세요.'],
    ['     email = 회사 구글계정 (@ekmtc.com)'],
    ['     role  = viewer / editor / admin  중 하나 (대소문자 무관)'],
    ['     note  = 메모(직책 등, 비워도 됨)'],
    [''],
    ['2) 저장하면 끝. 그 사람이 앱을 새로고침하면 바로 적용됩니다.'],
    ['     (재배포·동기화 필요 없음)'],
    [''],
    ['● 역할별 권한'],
    ['     viewer = 조회만'],
    ['     editor = 정비기록 추가 / 수정 / 삭제 + 스캔 업로드'],
    ['     admin  = 위 전부 + 선박·교정 마스터 수정 + 권한관리'],
    [''],
    ['● 권한 회수 = 해당 줄 삭제 → 다음 접속부터 접근 불가'],
    ['● 목록에 없는 회사계정 = 접근 불가 (조회도 안 됨)'],
    ['● 본인(배포자)은 목록과 무관하게 항상 admin (잠금 방지)'],
  ];
  sh.getRange(1, 5, guide.length, 1).setValues(guide);  // E열
  sh.getRange(1, 5).setFontWeight('bold');
  sh.setColumnWidth(5, 460);
  props.setProperty('ROLES_GUIDE_VER', ROLES_GUIDE_VER);
}

/* ── 부트스트랩: 클라이언트 초기 데이터 한 번에 ─────────────── */
var BOOTSTRAP_CACHE_SEC = 180;  // 3분 캐시
/** 데이터 변경 시 부트스트랩 캐시 무효화 */
function invalidateBootCache_() {
  try {
    var cache = CacheService.getScriptCache();
    cache.removeAll(['BOOT_viewer', 'BOOT_editor', 'BOOT_admin']);
  } catch (e) {}
}
function getBootstrap() {
  ensureSeed_();
  var role = getRole_();
  var email = Session.getActiveUser().getEmail() || '';
  if (!role) {
    return JSON.stringify({ email: email, role: '', noAccess: true });
  }
  // 캐시 히트 → 시트 읽기 완전 스킵 (역할별 키로 분리)
  var cache = CacheService.getScriptCache();
  var cacheKey = 'BOOT_' + role;
  var cached = cache.get(cacheKey);
  if (cached) {
    // email만 현재 사용자로 교체
    var obj = JSON.parse(cached);
    obj.email = email;
    obj.dbUrl = role === 'admin' ? getSS_().getUrl() : '';
    return JSON.stringify(obj);
  }
  var cals = readAll_('Calibrations');
  var bwtsCal = cals.filter(function (c) { return c.system === 'BWTS'; })
    .map(function (c) { c.lastCalibration = toDateStr_(c.lastCalibration); return c; });
  var egcsCal = cals.filter(function (c) { return c.system === 'EGCS'; })
    .map(function (c) {
      var d = toDateStr_(c.lastCalibration);
      var isDate = /^\d{4}-\d{2}-\d{2}$/.test(d);
      return { id: c.id, shipCode: c.shipCode, equip: c.equip,
        date: isDate ? d : '', text: isDate ? '' : (d || c.note || ''),
        serial: c.serial || '', model: c.model || '' };
    });
  var result = {
    email: email,
    role: role,
    dbUrl: role === 'admin' ? getSS_().getUrl() : '',
    ships: readAll_('Ships'),
    repairs: readAll_('Repairs').map(parseRepair_).map(function (r) {
      r.date = toDateStr_(r.date); return r;
    }),
    bwtsCal: bwtsCal,
    egcsCal: egcsCal,
    syncStatus: getSyncStatus_(),
    snapStatus: getSnapStatus_(),
    collectLog: getCollectLog_(),
  };
  // 캐시 저장 (100KB 이하만 — CacheService 제한)
  var json = JSON.stringify(result);
  try { cache.put(cacheKey, json, BOOTSTRAP_CACHE_SEC); } catch (e) {}
  return json;
}

/** 현재 시각 'yyyy-MM-dd HH:mm' (KST) */
function nowKst_() {
  return Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm');
}
/** 마지막 Gmail 수집 실행 현황 객체(없으면 null) */
var LAST_SYNC_KEY = 'LAST_GMAIL_SYNC';
function getSyncStatus_() {
  try { return JSON.parse(PropertiesService.getScriptProperties()
    .getProperty(LAST_SYNC_KEY) || 'null'); } catch (e) { return null; }
}
/** 마지막 대시보드 스냅샷 내보내기 성공/실패 현황(없으면 null) */
var SNAP_STATUS_KEY = 'LAST_SNAPSHOT_STATUS';
function getSnapStatus_() {
  try { return JSON.parse(PropertiesService.getScriptProperties()
    .getProperty(SNAP_STATUS_KEY) || 'null'); } catch (e) { return null; }
}
/* ── Gmail 자동수집 업데이트 로그(최근 30회) ───────────────────
   매 수집 회차에 무엇이 추가·첨부·매칭실패됐는지 누적해, 클라이언트
   '수집 로그' 모달에서 '어떤 게 업데이트됐는지' 확인할 수 있게 한다. */
var COLLECT_LOG_KEY = 'GMAIL_COLLECT_LOG';
function appendCollectLog_(entry) {
  // 변경분이 전혀 없으면 로그 생략(스팸 방지)
  if (!entry.added.length && !entry.attached.length &&
      !entry.unmatched.length && !entry.errors) return;
  var sp = PropertiesService.getScriptProperties();
  var log = [];
  try { log = JSON.parse(sp.getProperty(COLLECT_LOG_KEY) || '[]'); } catch (e) {}
  // 항목 배열은 회차당 최대 12개만 보관(프로퍼티 크기 한도 보호)
  log.unshift({
    at: entry.at, trigger: entry.trigger || 'manual',
    added: entry.added.slice(0, 12), attached: entry.attached.slice(0, 12),
    unmatched: entry.unmatched.slice(0, 12),
    addedN: entry.added.length, attachedN: entry.attached.length,
    unmatchedN: entry.unmatched.length, errors: entry.errors
  });
  if (log.length > 30) log = log.slice(0, 30);
  sp.setProperty(COLLECT_LOG_KEY, JSON.stringify(log));
}
function getCollectLog_() {
  try { return JSON.parse(PropertiesService.getScriptProperties()
    .getProperty(COLLECT_LOG_KEY) || '[]'); } catch (e) { return []; }
}

/* ── 대시보드 연동: 스냅샷 JSON을 Drive에 저장 ──────────────────
   공무팀 통합 대시보드(Dash)가 읽을 스냅샷. getBootstrap() 페이로드를 그대로 재사용.
   대상이 공유드라이브이므로 Advanced Drive Service(v3) 헬퍼를 사용한다.
   PC의 Drive for Desktop을 통해 G:\...\_dashboard\env_snapshot.json 로 동기화된다. */
var ENV_EXPORT_FOLDER_KEY = 'ENV_EXPORT_FOLDER_ID';   // 대상 폴더 ID(ScriptProperties, 선택)
var ENV_SNAPSHOT_NAME = 'env_snapshot.json';

function exportSnapshot() {
  requireRole_('editor');   // 편집 후 배경 호출 / 트리거(소유자=admin)만
  var sp = PropertiesService.getScriptProperties();
  try {
    var json = getBootstrap();   // {email, ships, repairs, bwtsCal, egcsCal} JSON 문자열
    var fid = sp.getProperty(ENV_EXPORT_FOLDER_KEY);
    var folderId = fid || driveEnsureChildFolder_(EGCS_ROOT_FALLBACK, '_dashboard');
    // env_snapshot.json (기존 호환)
    var blob = Utilities.newBlob(json, 'application/json', ENV_SNAPSHOT_NAME);
    var existingId = driveFindChildFile_(folderId, ENV_SNAPSHOT_NAME);
    if (existingId) {
      Drive.Files.update({}, existingId, blob, { supportsAllDrives: true });
    } else {
      Drive.Files.create({ name: ENV_SNAPSHOT_NAME, parents: [folderId] }, blob,
        { supportsAllDrives: true, fields: 'id' });
    }
    // env_data.js (로컬 HTML 대시보드용 — <script src>로 로드)
    var mailJson = '[]';
    try { mailJson = readMailLog(); } catch (em) {}
    var jsContent = '// Auto-generated ' + nowKst_() + '\n' +
      'var ENV_DATA = ' + json + ';\n' +
      'var MAIL_DATA_INIT = ' + mailJson + ';\n';
    var jsBlob = Utilities.newBlob(jsContent, 'application/javascript', 'env_data.js');
    var jsId = driveFindChildFile_(folderId, 'env_data.js');
    if (jsId) {
      Drive.Files.update({}, jsId, jsBlob, { supportsAllDrives: true });
    } else {
      Drive.Files.create({ name: 'env_data.js', parents: [folderId] }, jsBlob,
        { supportsAllDrives: true, fields: 'id' });
    }
    sp.setProperty(SNAP_STATUS_KEY, JSON.stringify({ at: nowKst_(), ok: true }));
    return ENV_SNAPSHOT_NAME;
  } catch (e) {
    sp.setProperty(SNAP_STATUS_KEY, JSON.stringify({
      at: nowKst_(), ok: false, error: String(e).slice(0, 200) }));
    throw e;
  }
}

/** parent 하위에서 name과 일치하는 파일 id 반환(없으면 null) */
function driveFindChildFile_(parentId, name) {
  var q = "'" + parentId + "' in parents and trashed=false and name='" + qEscape_(name) + "'";
  var res = Drive.Files.list({
    q: q, corpora: 'allDrives', supportsAllDrives: true,
    includeItemsFromAllDrives: true, fields: 'files(id)', pageSize: 1
  });
  return (res.files && res.files.length) ? res.files[0].id : null;
}

/* 최초 1회 실행: 1시간마다 스냅샷 자동 갱신 트리거 설치(중복 방지). */
function installSnapshotTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'exportSnapshot';
  });
  if (exists) return 'already installed';
  ScriptApp.newTrigger('exportSnapshot').timeBased().everyHours(1).create();
  return 'installed';
}

/* ── Gmail 자동수집 트리거 ─────────────────────────────────────
   매일 새 인증서/서비스리포트를 자동으로 Drive 저장 + 수리이력 기록.
   collectGmail은 5층 중복방지가 있어 반복 실행(REAL)이 안전하다.
   최초 1회 에디터에서 installGmailTrigger() 실행(스코프 승인 필요). */
function installGmailTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'autoCollectGmail';
  });
  if (exists) return 'already installed';
  ScriptApp.newTrigger('autoCollectGmail').timeBased().everyDays(1).atHour(6).create();
  return 'installed';
}

/** 트리거 진입점 — 최근 메일만 자동 수집(REAL) + Gemini 요약 후 스냅샷 갱신.
   요약은 OCR+API 호출로 느려서 배치를 작게(6분 제한 회피). 남은 건 다음 회차. */
function autoCollectGmail() {
  var t0 = Date.now();
  var rep = collectGmail({ dryRun: false, window: 'newer_than:60d',
    batch: 8, summarize: true, trigger: 'auto' });
  // BWTS 검교정 인증서 자동 동기화 (매일 트리거 시 함께 실행)
  if (getRemainingTime_(t0) > 90) {
    try { syncBwtsCal_(false); } catch (e) {
      Logger.log('syncBwtsCal_ error: ' + e);
    }
  } else { Logger.log('syncBwtsCal_ skipped (time)'); }
  // 메이커 텍스트 메일 수집 (PDF 없는 기술 메일)
  if (getRemainingTime_(t0) > 60) {
    try { collectMakerText_(false, { batch: 5 }); } catch (e) {
      Logger.log('collectMakerText_ error: ' + e);
    }
  } else { Logger.log('collectMakerText_ skipped (time)'); }
  // 스냅샷은 collectGmail이 변경분 있을 때만 1회 수행(중복 제거)
  Logger.log(JSON.stringify(rep));
  return rep;
}

/* ── 검교정 만료·임박 주간 자동알림 ───────────────────────────
   판정 로직은 클라이언트(JavaScript.html SENSOR_CYCLE/dueOf)와 동일 출처
   (EGCS_WMS_센서_운영_매뉴얼 2026.06.18). 서버에서 직접 계산해 메일 발송. */
var ALERT_RECIPIENT_KEY = 'CAL_ALERT_RECIPIENT';
var ALERT_RECIPIENT_DEFAULT = 'hwjung@ekmtc.com';
// 센서 모델별 검교정/신환 주기(개월). cal:null = 고정 검교정주기 없음('필요시')
var SENSOR_CYCLE_GS = {
  'enviroFlu': { cal: 48, repl: 96 }, 'TTurb': { cal: 48, repl: 96 },
  'TpH-D': { cal: 24, repl: 24 }, 'G6110': { cal: 24, repl: 48 },
  'G6111': { cal: 36, repl: 36 }, 'G6120': { cal: null, repl: 60 },
  'G6130': { cal: 12, repl: 12 }
};
function equipKind_(equip) {
  if (/PAH/.test(equip)) return 'PAH';
  if (/TURB/.test(equip)) return 'TURB';
  return 'PH';
}
function wmsMakerOf_(wms) {
  var w = String(wms || '').toUpperCase();
  if (w.indexOf('TRI') >= 0) return 'TRIOS';
  if (w.indexOf('GI') >= 0 || w.indexOf('GREEN') >= 0) return 'GI';
  return '';
}
function sensorModel_(maker, equip, model) {
  var kind = equipKind_(equip);
  if (maker === 'TRIOS') return kind === 'PAH' ? 'enviroFlu' : (kind === 'TURB' ? 'TTurb' : 'TpH-D');
  if (maker === 'GI') {
    if (kind === 'TURB') return 'G6120';
    if (kind === 'PH') return 'G6130';
    return (model && SENSOR_CYCLE_GS[model]) ? model : null;  // GI PAH: 모델 지정 필수
  }
  return null;
}
function dueDays_(dateStr, months) {
  var s = toDateStr_(dateStr);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || months == null) return null;
  var p = s.split('-');
  var due = new Date(Number(p[0]), Number(p[1]) - 1 + months, Number(p[2]));
  return { days: Math.round((due - new Date()) / 86400000), due: due };
}
/** 만료·임박 항목 수집: BWTS(12개월, 2개월 이내) + EGCS(검교정·신환, 30일 이내)
 *  EGCS 중복 방지: cal===repl이면 검교정만 표시.
 *  cal!==repl이면 먼저 도래하는 쪽만 표시(둘 다 30일 이내면 먼저 만료되는 것). */
function calAlertItems_() {
  var wmsByCode = {};
  readAll_('Ships').forEach(function (s) { wmsByCode[s.code] = s.wms; });
  // equip 정규화: "WMS1-PH" ↔ "WMS1/PH" 통일 → "WMS1/PH"
  function normEquip(e) { return String(e || '').replace(/^(WMS\d)[-\/]/, '$1/'); }
  var seen = {};  // dedup 키: "shipCode|normEquip|kind"
  var out = [];
  function addItem(item) {
    var key = item.code + '|' + normEquip(item.equip) + '|' + item.kind;
    if (seen[key]) return;  // 같은 선박+센서+구분 이미 등록됨
    seen[key] = true;
    item.equip = normEquip(item.equip);
    out.push(item);
  }
  readAll_('Calibrations').forEach(function (c) {
    var date = toDateStr_(c.lastCalibration);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    if (c.system === 'BWTS') {
      var b = dueDays_(date, 12);
      if (b && b.days <= 60) addItem({ code: c.shipCode, sys: 'BWTS',
        equip: 'BWTS 연간', kind: '검교정', days: b.days, due: b.due });
      return;
    }
    var m = sensorModel_(wmsMakerOf_(wmsByCode[c.shipCode]), c.equip, c.model);
    if (!m) return;
    var cyc = SENSOR_CYCLE_GS[m];
    // cal===repl → 검교정만 (신환과 동일 주기이므로 중복 표시 불필요)
    if (cyc.cal != null && cyc.cal === cyc.repl) {
      var cal = dueDays_(date, cyc.cal);
      if (cal && cal.days <= 30) addItem({ code: c.shipCode, sys: 'EGCS',
        equip: c.equip, kind: '검교정', days: cal.days, due: cal.due });
      return;
    }
    // cal!==repl → 먼저 도래하는 쪽만 표시
    var calItem = null, replItem = null;
    if (cyc.cal != null) {
      var calD = dueDays_(date, cyc.cal);
      if (calD && calD.days <= 30) calItem = { code: c.shipCode, sys: 'EGCS',
        equip: c.equip, kind: '검교정', days: calD.days, due: calD.due };
    }
    var replD = dueDays_(date, cyc.repl);
    if (replD && replD.days <= 30) replItem = { code: c.shipCode, sys: 'EGCS',
      equip: c.equip, kind: '신환', days: replD.days, due: replD.due };
    if (calItem && replItem) {
      addItem(calItem.days <= replItem.days ? calItem : replItem);
    } else {
      if (calItem) addItem(calItem);
      if (replItem) addItem(replItem);
    }
  });
  out.sort(function (a, b) { return a.days - b.days; });
  return out;
}
/** 주간 검교정 알림 메일(트리거 진입점). 0건이면 미발송.
 *  BWTS / EGCS 섹션 분리, 컬러 구분 적용. */
function weeklyCalAlert() {
  var items = calAlertItems_();
  if (!items.length) { Logger.log('weeklyCalAlert: 0건 — 미발송'); return { sent: false, count: 0 }; }
  var expiredN = items.filter(function (i) { return i.days <= 0; }).length;
  var bwtsItems = items.filter(function (i) { return i.sys === 'BWTS'; });
  var egcsItems = items.filter(function (i) { return i.sys === 'EGCS'; });

  var TD = 'border:1px solid #e2e8f0;padding:7px 10px';
  function statusCell(it) {
    var color = it.days <= 0 ? '#b91c1c' : '#b45309';
    var status = it.days <= 0 ? (Math.abs(it.days) + '일 경과(만료)') : ('D-' + it.days + ' 임박');
    return '<span style="color:' + color + ';font-weight:600">' + status + '</span>';
  }
  function bgOf(it) { return it.days <= 0 ? '#fef2f2' : '#fffbeb'; }

  // BWTS: 단순 행 (선박 합치기만)
  function buildBwtsRows(list) {
    // 선박별 그룹
    var groups = [], cur = null;
    list.forEach(function (it) {
      if (!cur || cur.code !== it.code) { cur = { code: it.code, items: [] }; groups.push(cur); }
      cur.items.push(it);
    });
    var rows = '';
    groups.forEach(function (g) {
      g.items.forEach(function (it, i) {
        rows += '<tr style="background:' + bgOf(it) + '">';
        if (i === 0) rows += '<td style="' + TD + ';font-weight:600" rowspan="' + g.items.length + '">' + g.code + '</td>';
        rows += '<td style="' + TD + '">' + it.equip + '</td>' +
          '<td style="' + TD + '">' + it.kind + '</td>' +
          '<td style="' + TD + '">' + Utilities.formatDate(it.due, 'Asia/Seoul', 'yyyy-MM-dd') + '</td>' +
          '<td style="' + TD + '">' + statusCell(it) + '</td></tr>';
      });
    });
    return rows;
  }

  // EGCS: 선박 → WMS → 센서 계층 합치기
  // equip 형식: "WMS1/PH", "WMS2/TURB" 등
  function buildEgcsRows(list) {
    // 정렬: 선박 → WMS → 센서
    list.sort(function (a, b) {
      if (a.code !== b.code) return a.code < b.code ? -1 : 1;
      var aw = (a.equip.match(/WMS(\d)/) || [,'9'])[1];
      var bw = (b.equip.match(/WMS(\d)/) || [,'9'])[1];
      if (aw !== bw) return aw < bw ? -1 : 1;
      return a.equip < b.equip ? -1 : (a.equip > b.equip ? 1 : 0);
    });
    // 선박별 그룹 → WMS별 서브그룹
    var ships = [], curShip = null;
    list.forEach(function (it) {
      if (!curShip || curShip.code !== it.code) { curShip = { code: it.code, wmsList: [], total: 0 }; ships.push(curShip); }
      var wmsNum = (it.equip.match(/WMS(\d)/) || [,'?'])[1];
      var sensor = it.equip.replace(/^WMS\d[\-\/]?/, '');
      var curWms = curShip.wmsList.length ? curShip.wmsList[curShip.wmsList.length - 1] : null;
      if (!curWms || curWms.wms !== wmsNum) { curWms = { wms: wmsNum, items: [] }; curShip.wmsList.push(curWms); }
      curWms.items.push({ sensor: sensor, kind: it.kind, due: it.due, days: it.days, bg: bgOf(it), statusHtml: statusCell(it) });
      curShip.total++;
    });
    var rows = '';
    ships.forEach(function (ship) {
      var shipFirst = true;
      ship.wmsList.forEach(function (wg) {
        wg.items.forEach(function (it, i) {
          rows += '<tr style="background:' + it.bg + '">';
          if (shipFirst) { rows += '<td style="' + TD + ';font-weight:600;vertical-align:middle" rowspan="' + ship.total + '">' + ship.code + '</td>'; shipFirst = false; }
          if (i === 0) rows += '<td style="' + TD + ';vertical-align:middle;text-align:center" rowspan="' + wg.items.length + '">WMS' + wg.wms + '</td>';
          rows += '<td style="' + TD + '">' + it.sensor + '</td>' +
            '<td style="' + TD + '">' + it.kind + '</td>' +
            '<td style="' + TD + '">' + Utilities.formatDate(it.due, 'Asia/Seoul', 'yyyy-MM-dd') + '</td>' +
            '<td style="' + TD + '">' + it.statusHtml + '</td></tr>';
        });
      });
    });
    return rows;
  }

  function buildHeader(cols, bgColor) {
    return '<tr style="background:' + bgColor + ';color:#fff">' + cols.map(function (h) {
      return '<th style="' + TD + ';text-align:left">' + h + '</th>';
    }).join('') + '</tr>';
  }
  function sectionSummary(count, sysItems) {
    var expN = sysItems.filter(function (i) { return i.days <= 0; }).length;
    return ' <span style="font-weight:400;font-size:13px;color:#64748b">(' +
      count + '건 · 만료 ' + expN + ' · 임박 ' + (count - expN) + ')</span>';
  }

  var bwtsHtml = '';
  if (bwtsItems.length) {
    bwtsHtml = '<div style="margin-bottom:20px">' +
      '<h3 style="color:#1e40af;margin:0 0 6px;font-size:15px">⚓ BWTS' + sectionSummary(bwtsItems.length, bwtsItems) + '</h3>' +
      '<table style="border-collapse:collapse;font-size:12.5px;width:100%">' +
      '<thead>' + buildHeader(['선박', '장비', '구분', '만료일', '상태'], '#1e40af') + '</thead>' +
      '<tbody>' + buildBwtsRows(bwtsItems) + '</tbody></table></div>';
  }
  var egcsHtml = '';
  if (egcsItems.length) {
    egcsHtml = '<div style="margin-bottom:20px">' +
      '<h3 style="color:#065f46;margin:0 0 6px;font-size:15px">🏭 EGCS' + sectionSummary(egcsItems.length, egcsItems) + '</h3>' +
      '<table style="border-collapse:collapse;font-size:12.5px;width:100%">' +
      '<thead>' + buildHeader(['선박', 'WMS', '센서', '구분', '만료일', '상태'], '#065f46') + '</thead>' +
      '<tbody>' + buildEgcsRows(egcsItems) + '</tbody></table></div>';
  }

  var html = '<div style="font-family:Malgun Gothic,sans-serif;font-size:13px;color:#1f2426">' +
    '<h2 style="color:#155060;margin:0 0 4px;font-size:17px">검교정 만료·임박 주간 리포트</h2>' +
    '<p style="color:#64748b;margin:0 0 16px;font-size:12.5px">총 <b>' + items.length +
    '건</b> (만료 ' + expiredN + ' · 임박 ' + (items.length - expiredN) +
    '). 기준: BWTS 2개월 이내 · EGCS 30일 이내. 주기 출처: WMS 센서 매뉴얼(2026.06.18).</p>' +
    bwtsHtml + egcsHtml +
    '<p style="color:#94a3b8;font-size:11.5px;margin-top:10px;border-top:1px solid #e2e8f0;padding-top:10px">' +
    '※ USCG/검교정 만료는 PSC 지적 사유입니다. 앱 검교정 보드에서 상세를 확인하세요.<br>' +
    '이 메일은 매주 월요일 오전 8시 자동 발송됩니다.</p></div>';

  var to = PropertiesService.getScriptProperties().getProperty(ALERT_RECIPIENT_KEY) ||
    ALERT_RECIPIENT_DEFAULT;
  var subj = '[검교정] 주간 만료·임박 ' + items.length + '건';
  if (bwtsItems.length && egcsItems.length) subj += ' (BWTS ' + bwtsItems.length + ' · EGCS ' + egcsItems.length + ')';
  else if (bwtsItems.length) subj += ' (BWTS)';
  else subj += ' (EGCS)';
  MailApp.sendEmail({ to: to, htmlBody: html, subject: subj });
  Logger.log('weeklyCalAlert: ' + items.length + '건 발송 → ' + to);
  return { sent: true, count: items.length, expired: expiredN, to: to };
}
/** 주간 알림 트리거 설치(매주 월 08시). 중복 방지. */
function installCalAlertTrigger() {
  var exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'weeklyCalAlert';
  });
  if (exists) return 'already installed';
  ScriptApp.newTrigger('weeklyCalAlert').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  return 'installed';
}

/** 스냅샷 + Gmail + 검교정알림 트리거를 한 번에 설치(편집기 클릭 실행용). */
function installAllTriggers() {
  return { snapshot: installSnapshotTrigger(), gmail: installGmailTrigger(),
    calAlert: installCalAlertTrigger() };
}

/** 트리거 강제 재설치 — 기존 것 삭제 후 새로 생성.
   스코프 추가 후 트리거가 '권한 필요'로 멈췄을 때 사용(현재 권한으로 재바인딩).
   실행 시 권한 팝업이 뜨면 승인할 것. */
function reinstallTriggers() {
  var removed = [];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (f === 'exportSnapshot' || f === 'autoCollectGmail' || f === 'weeklyCalAlert') {
      ScriptApp.deleteTrigger(t); removed.push(f);
    }
  });
  ScriptApp.newTrigger('exportSnapshot').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('autoCollectGmail').timeBased().everyDays(1).atHour(6).create();
  ScriptApp.newTrigger('weeklyCalAlert').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  var rep = { removed: removed,
    installed: ['exportSnapshot', 'autoCollectGmail', 'weeklyCalAlert'] };
  Logger.log(JSON.stringify(rep));
  return rep;
}

/** 현재 설치된 트리거 목록 진단. */
function run_listTriggers() {
  var rep = ScriptApp.getProjectTriggers().map(function (t) {
    return { fn: t.getHandlerFunction(), type: String(t.getEventType()) };
  });
  Logger.log(JSON.stringify(rep, null, 2));
  return rep;
}

function pad2_(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

/** Date 셀 / 'YYYY. M. D.' / 'YYYY-M-D' → 'yyyy-MM-dd' 정규화 (아니면 원문) */
function toDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  var s = (v == null ? '' : String(v)).trim();
  if (!s) return '';
  var m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
  return s;
}

/* ── 공유(대시보드) 시트에서 검교정 읽기 ─────────────────────
   읽기 전용. 대시보드가 쓰는 스프레드시트를 단일 소스로 직접 읽음. */
var SHARED_SS_ID = '1Kv7dIhAs_QfvccAxjGev-EutU_VtgOm4TQclDB72Y6A';
var BWTS_CAL_GID = 297341548;  // BWTS 연간 검교정 탭
var EGCS_CAL_GID = 275918466;  // EGCS WMS 검교정 매트릭스 탭

function getSheetByGid_(ss, gid) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === gid) return sheets[i];
  }
  return null;
}

/** 공유 대시보드 시트에서 EGCS 매트릭스 1회 import (앱 DB로 이관) */
function readSharedEgcs_() {
  try {
    return readEgcsCal_(SpreadsheetApp.openById(SHARED_SS_ID));
  } catch (e) { return []; }
}

/** EGCS WMS 검교정 매트릭스 — 모든 탭을 훑어 WMS1/PH… 매트릭스를 찾아 파싱 */
function readEgcsCal_(ss) {
  var sheets = ss.getSheets();
  for (var si = 0; si < sheets.length; si++) {
    var res = parseEgcsMatrix_(sheets[si].getDataRange().getValues());
    if (res.length) return res;
  }
  return [];
}
function parseEgcsMatrix_(data) {
  // 헤더: [0]==='선명' 이고 선박코드 셀이 3개 이상인 행 (선박은 보통 C열부터)
  var hdr = -1, ships = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() !== '선명') continue;
    var s = [];
    for (var c = 1; c < data[i].length; c++) {
      var code = String(data[i][c]).trim();
      if (/^K[A-Z]{2}$/.test(code)) s.push({ col: c, code: code });
    }
    if (s.length >= 3) { hdr = i; ships = s; break; }
  }
  if (hdr < 0) return [];
  // 장비: A열 그룹(WMS1/WMS2, 병합→이월) + B열 세부(PH/TURB/PAH)
  var out = [], group = '';
  for (var r = hdr + 1; r < data.length; r++) {
    var g = String(data[r][0]).trim().replace(/\s+/g, '').toUpperCase();
    if (/^WMS[12]$/.test(g)) group = g;
    var sub = String(data[r][1]).trim().toUpperCase();
    var mm = sub.match(/^(PH|TURB|TURBIDITY|PAH)$/);
    if (!group || !mm) continue;
    var equip = group + '/' + (mm[1] === 'TURBIDITY' ? 'TURB' : mm[1]);
    ships.forEach(function (sp) {
      var raw = data[r][sp.col];
      var d = toDateStr_(raw);
      var isDate = /^\d{4}-\d{2}-\d{2}$/.test(d);
      out.push({ shipCode: sp.code, equip: equip, date: isDate ? d : '', text: isDate ? '' : d });
    });
  }
  return out;
}

function parseRepair_(r) {
  r.date = toDateStr_(r.date);   // Date 셀/ISO/문자열 → 'yyyy-MM-dd' 정규화(멱등)
  r.needsReview = (r.needsReview === true ||
                   String(r.needsReview).toLowerCase() === 'true');   // 시트값 → 불리언
  try { r.attachments = r.attachments ? JSON.parse(r.attachments) : []; }
  catch (e) { r.attachments = []; }
  try { r.history = r.history ? JSON.parse(r.history) : []; }
  catch (e) { r.history = []; }
  if (!r.history.length) {
    r.history = [{ stage: r.stage || 'reported', date: r.date || '',
      note: '', at: r.createdAt || '' }];
  }
  return r;
}

/* ── 수리 이력 CRUD ────────────────────────────────────────── */
function addRepair(data) {
  requireRole_('editor');
  var now = new Date();
  var id = data.id || (data.shipCode + '_' + now.getTime());
  var obj = {
    id: id,
    shipCode: data.shipCode,
    system: data.system === 'EGCS' ? 'EGCS' : 'BWTS',
    date: data.date || '',
    equip: data.equip || '',
    stage: data.stage || 'reported',
    symptom: data.symptom || '',
    action: data.action || '',
    parts: data.parts || '',
    cost: data.cost || '',
    attachments: JSON.stringify(data.attachments || []),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    history: JSON.stringify([{
      stage: data.stage || 'reported', date: data.date || '',
      note: '접수', at: now.toISOString()
    }]),
    sourceFolderId: data.sourceFolderId || '',
    sourceMsgId: data.sourceMsgId || '',
    needsReview: data.needsReview ? true : '',
    emailSubject: data.emailSubject || '',
    emailLink: data.emailLink || '',
  };
  upsert_('Repairs', 'id', obj);
  invalidateBootCache_();
  return JSON.stringify(parseRepair_(obj));
}

function updateRepair(id, patch) {
  requireRole_('editor');
  var rows = readAll_('Repairs');
  var cur = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) cur = rows[i];
  if (!cur) throw new Error('수리 기록을 찾을 수 없습니다: ' + id);
  Object.keys(patch).forEach(function (k) {
    if (k === 'attachments' || k === 'history') cur[k] = JSON.stringify(patch[k]);
    else cur[k] = patch[k];
  });
  cur.updatedAt = new Date().toISOString();
  upsert_('Repairs', 'id', cur);
  invalidateBootCache_();
  return JSON.stringify(parseRepair_(cur));
}

function deleteRepair(id) {
  requireRole_('editor');
  var rowNum = findRow_('Repairs', 'id', id);
  if (rowNum > 0) sheet_('Repairs').deleteRow(rowNum);
  invalidateBootCache_();
  return true;
}

/* ── Gmail 수집 중복 정리 (관리자) ─────────────────────────────
   GM_ 행만 대상. 같은 선박|시스템|제목(equip)|일자를 한 건으로 보고,
   첨부가 가장 많은 행을 유지·나머지는 삭제(첨부는 유지행으로 병합). */
function gmailDuplicateGroups_() {
  var groups = {};
  readAll_('Repairs').map(parseRepair_).forEach(function (r) {
    if (String(r.id).indexOf('GM_') !== 0) return;   // Gmail 수집분만(수동입력 보호)
    var key = [r.shipCode, r.system || 'BWTS',
               String(r.equip || '').trim(), toDateStr_(r.date)].join('|');
    (groups[key] = groups[key] || []).push(r);
  });
  var out = [];
  Object.keys(groups).forEach(function (key) {
    var g = groups[key];
    if (g.length < 2) return;                         // 중복 아님
    g.sort(function (a, b) {                          // 유지행 우선순위
      var na = (a.attachments || []).length, nb = (b.attachments || []).length;
      if (nb !== na) return nb - na;                  // 첨부 많은 행
      var la = String(a.action || '').length, lb = String(b.action || '').length;
      if (lb !== la) return lb - la;                  // 내용 긴 행
      return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); // 먼저 등록된 행
    });
    out.push({ keep: g[0], drop: g.slice(1) });
  });
  return out;
}

/** DRY-RUN: 무엇을 유지/삭제할지 목록만 반환(삭제 안 함). */
function scanGmailDuplicates() {
  requireRole_('admin');
  var groups = gmailDuplicateGroups_();
  var dropCount = 0;
  function brief(r) {
    return { id: r.id, date: toDateStr_(r.date), equip: r.equip,
             atts: (r.attachments || []).length };
  }
  var view = groups.map(function (gr) {
    dropCount += gr.drop.length;
    return { shipCode: gr.keep.shipCode, system: gr.keep.system,
             keep: brief(gr.keep), drop: gr.drop.map(brief) };
  });
  return JSON.stringify({ groups: view, groupCount: groups.length, dropCount: dropCount });
}

/** 실제 정리: 유지행에 삭제행 첨부 병합 후 삭제. 갱신된 STATE 반환. */
function purgeGmailDuplicates() {
  requireRole_('admin');
  var groups = gmailDuplicateGroups_();
  var deleted = 0;
  groups.forEach(function (gr) {
    var seen = {}, merged = (gr.keep.attachments || []).slice();
    merged.forEach(function (a) { if (a && a.url) seen[a.url] = true; });
    gr.drop.forEach(function (r) {
      (r.attachments || []).forEach(function (a) {
        if (a && a.url && !seen[a.url]) { seen[a.url] = true; merged.push(a); }
      });
    });
    if (merged.length !== (gr.keep.attachments || []).length) {
      updateRepair(gr.keep.id, { attachments: merged });   // 첨부 보존
    }
    gr.drop.forEach(function (r) { deleteRepair(r.id); deleted++; });
  });
  return JSON.stringify({ deleted: deleted, bootstrap: getBootstrap() });
}

/* ── 데이터 정비 (관리자) ──────────────────────────────────────
   1) backfillEmailSubjects: 기존 GM_ 레코드에 emailSubject 역보충
   2) auditShipCoverage: 수리/검교정 이력 없는 선박 감지
   3) mergeThreadDuplicates: 같은 스레드(Re:/Fw:) 메일을 하나로 병합 */

/** 기존 GM_ 레코드의 emailSubject가 비었으면 sourceMsgId로 Gmail에서 제목 가져와 보충.
    배치 처리(1회 최대 20건, 5분 제한). 여러 번 눌러서 전부 처리.
    반환: { updated, skipped, errors, remaining } */
function backfillEmailSubjects() {
  requireRole_('admin');
  var t0 = Date.now();
  var BATCH = 20;
  var TIME_LIMIT = 280000; // 4분 40초
  var repairs = readAll_('Repairs');
  var updated = 0, skipped = 0, errors = [], remaining = 0;
  var processed = 0;
  for (var i = 0; i < repairs.length; i++) {
    var r = repairs[i];
    if (String(r.id).indexOf('GM_') !== 0) continue;
    if (r.emailSubject) { skipped++; continue; }
    var rawMsgId = String(r.sourceMsgId || '').split(' ')[0]
      .replace(/^etp:/, '').replace(/^mkr:/, '');
    if (!rawMsgId) { skipped++; continue; }
    if (processed >= BATCH || (Date.now() - t0) > TIME_LIMIT) {
      // 남은 건수 세기
      for (var j = i; j < repairs.length; j++) {
        if (String(repairs[j].id).indexOf('GM_') === 0 && !repairs[j].emailSubject) remaining++;
      }
      break;
    }
    try {
      var msg = GmailApp.getMessageById(rawMsgId);
      if (!msg) { skipped++; processed++; continue; }
      var subject = msg.getSubject() || '';
      var link = gmailMessageUrl_(msg);
      var patch = { emailSubject: subject };
      if (link) patch.emailLink = link;
      if (/^Gmail 자동수집/.test(String(r.action || ''))) {
        patch.action = '[메일] ' + subject;
      }
      updateRepair(r.id, patch);
      updated++;
      processed++;
    } catch (e) {
      errors.push(r.id + ': ' + String(e).slice(0, 80));
      processed++;
    }
  }
  return JSON.stringify({ updated: updated, skipped: skipped,
    errors: errors, remaining: remaining });
}

/** 수리/검교정 이력 없는 선박 목록 반환. */
function auditShipCoverage() {
  requireRole_('admin');
  var ships = readAll_('Ships');
  var repairs = readAll_('Repairs');
  var calibs = readAll_('Calibrations');
  var repairShips = {}, calibShips = {};
  repairs.forEach(function (r) {
    var k = r.shipCode + '|' + (r.system || 'BWTS');
    repairShips[k] = (repairShips[k] || 0) + 1;
  });
  calibs.forEach(function (c) {
    var k = c.shipCode + '|' + (c.system || 'BWTS');
    calibShips[k] = (calibShips[k] || 0) + 1;
  });
  var gaps = [];
  ships.forEach(function (s) {
    ['BWTS', 'EGCS'].forEach(function (sys) {
      if (sys === 'EGCS' && !s.egcs_maker) return;
      var k = s.code + '|' + sys;
      if (!repairShips[k] && !calibShips[k]) {
        gaps.push({ code: s.code, name: s.name, system: sys,
          repairs: 0, calibrations: 0 });
      } else if (!repairShips[k]) {
        gaps.push({ code: s.code, name: s.name, system: sys,
          repairs: 0, calibrations: calibShips[k] || 0 });
      }
    });
  });
  return JSON.stringify(gaps);
}

/** 같은 스레드의 GM_ 레코드를 하나로 병합 (가장 첨부 많은 걸 유지).
    기존 scanGmailDuplicates보다 넓은 기준: equip 유사도 포함. */
function mergeThreadDuplicates() {
  requireRole_('admin');
  var repairs = readAll_('Repairs').map(parseRepair_).filter(function (r) {
    return String(r.id).indexOf('GM_') === 0;
  });
  // 스레드 ID로 그룹핑
  var threadGroups = {};
  repairs.forEach(function (r) {
    var src = String(r.sourceMsgId || '');
    var thMatch = src.match(/@thread:(\S+)/);
    if (!thMatch) return;
    var thId = thMatch[1];
    (threadGroups[thId] = threadGroups[thId] || []).push(r);
  });
  var merged = 0, deleted = 0;
  Object.keys(threadGroups).forEach(function (thId) {
    var g = threadGroups[thId];
    if (g.length < 2) return;
    // 같은 스레드 + 같은 선박 + 같은 시스템 → 병합
    var byShip = {};
    g.forEach(function (r) {
      var k = r.shipCode + '|' + (r.system || 'BWTS');
      (byShip[k] = byShip[k] || []).push(r);
    });
    Object.keys(byShip).forEach(function (k) {
      var items = byShip[k];
      if (items.length < 2) return;
      // 유지행: 첨부 많은 순 → 내용 긴 순 → 먼저 등록된 순
      items.sort(function (a, b) {
        var na = (a.attachments || []).length, nb = (b.attachments || []).length;
        if (nb !== na) return nb - na;
        var la = String(a.action || '').length, lb = String(b.action || '').length;
        if (lb !== la) return lb - la;
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
      var keep = items[0], drop = items.slice(1);
      // 첨부 병합
      var seen = {}, allAtts = (keep.attachments || []).slice();
      allAtts.forEach(function (a) { if (a && a.url) seen[a.url] = true; });
      drop.forEach(function (r) {
        (r.attachments || []).forEach(function (a) {
          if (a && a.url && !seen[a.url]) { seen[a.url] = true; allAtts.push(a); }
        });
      });
      if (allAtts.length !== (keep.attachments || []).length) {
        updateRepair(keep.id, { attachments: allAtts });
      }
      drop.forEach(function (r) { deleteRepair(r.id); deleted++; });
      merged++;
    });
  });
  return JSON.stringify({ mergedGroups: merged, deletedRows: deleted });
}

/** 특정 선박의 수리 레코드 요약 반환 (중복 진단용). */
function diagRepairs(shipCode) {
  requireRole_('admin');
  var repairs = readAll_('Repairs').map(parseRepair_).filter(function (r) {
    return r.shipCode === shipCode;
  });
  // equip별 그룹
  var byEquip = {};
  repairs.forEach(function (r) {
    var k = (r.equip || '(빈값)') + '|' + (r.system || 'BWTS');
    if (!byEquip[k]) byEquip[k] = [];
    byEquip[k].push({
      id: r.id, date: toDateStr_(r.date), equip: r.equip,
      action: String(r.action || '').substring(0, 60),
      emailSubject: r.emailSubject || '',
      atts: (r.attachments || []).length,
      isGM: String(r.id).indexOf('GM_') === 0
    });
  });
  return JSON.stringify({ shipCode: shipCode, total: repairs.length, groups: byEquip });
}

/* ── 검교정 갱신 ───────────────────────────────────────────── */
/** BWTS 검교정 폴더 URL (없으면 생성) */
function getBwtsCalFolderUrl(shipCode, calDate) {
  // 날짜 미전달 시 DB에서 조회
  if (!calDate) {
    var cals = readAll_('Calibrations');
    for (var i = 0; i < cals.length; i++) {
      if (cals[i].shipCode === shipCode &&
          cals[i].system === 'BWTS' &&
          cals[i].equip === '연간검교정') {
        calDate = toDateStr_(cals[i].lastCalibration);
        break;
      }
    }
  }
  var folderId = getEventFolder_(
    'BWTS', shipCode, calDate || '', 'Annual Calibration');
  return driveFolderUrl_(folderId);
}

/** BWTS CERT 파일 업로드 → Drive 저장 → URL 반환 */
function uploadBwtsCert(shipCode, file, date) {
  requireRole_('admin');
  var folderId = getEventFolder_(
    'BWTS', shipCode, date || '', 'Annual Calibration');
  var bytes = Utilities.base64Decode(file.dataBase64);
  var blob = Utilities.newBlob(
    bytes, file.mimeType || 'application/pdf',
    file.name || 'cert.pdf');
  var name = file.name || 'cert.pdf';
  var i = 2;
  while (driveFileExistsByName_(folderId, name)) {
    var dot = (file.name || '').lastIndexOf('.');
    var base = dot > 0 ? file.name.substring(0, dot) : file.name;
    var ext = dot > 0 ? file.name.substring(dot) : '';
    name = base + ' (' + i + ')' + ext; i++;
  }
  var created = Drive.Files.create(
    { name: name, parents: [folderId] }, blob,
    { supportsAllDrives: true,
      fields: 'id,name,webViewLink' });
  return { name: created.name, url: created.webViewLink,
    id: created.id };
}

function updateCalibration(id, patch) {
  requireRole_('admin');   // 교정 마스터 = 관리자만
  var rows = readAll_('Calibrations');
  var cur = null;
  for (var i = 0; i < rows.length; i++) if (rows[i].id === id) cur = rows[i];
  if (!cur) cur = { id: id, shipCode: id.split('_')[0], equip: id.split('_')[1] };
  Object.keys(patch).forEach(function (k) { cur[k] = patch[k]; });
  cur.updatedAt = new Date().toISOString();
  upsert_('Calibrations', 'id', cur);
  invalidateBootCache_();
  return cur;
}

/* ── Drive API v3 헬퍼 (공유드라이브 지원) ────────────────────
   대상 폴더가 공유드라이브에 있어 DriveApp 대신 Advanced Drive Service(v3)를
   쓴다. 모든 호출에 supportsAllDrives / includeItemsFromAllDrives 적용. */

/** Drive 검색식 문자열 리터럴용 이스케이프 */
function qEscape_(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** parent 하위에서 name과 일치하는 폴더 id 반환(없으면 null) */
function driveFindChildFolder_(parentId, name) {
  var q = "'" + parentId + "' in parents and trashed=false and " +
          "mimeType='application/vnd.google-apps.folder' and name='" + qEscape_(name) + "'";
  var res = Drive.Files.list({
    q: q, corpora: 'allDrives', supportsAllDrives: true,
    includeItemsFromAllDrives: true, fields: 'files(id,name)', pageSize: 10
  });
  return (res.files && res.files.length) ? res.files[0].id : null;
}

/** parent 하위 name 폴더를 찾고 없으면 생성, id 반환 */
function driveEnsureChildFolder_(parentId, name) {
  var id = driveFindChildFolder_(parentId, name);
  if (id) return id;
  var created = Drive.Files.create(
    { name: name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
    null, { supportsAllDrives: true, fields: 'id' });
  return created.id;
}

/** parent 하위에 동일 이름 파일이 있는지 */
function driveFileExistsByName_(parentId, name) {
  var q = "'" + parentId + "' in parents and trashed=false and name='" + qEscape_(name) + "'";
  var res = Drive.Files.list({
    q: q, corpora: 'allDrives', supportsAllDrives: true,
    includeItemsFromAllDrives: true, fields: 'files(id)', pageSize: 1
  });
  return !!(res.files && res.files.length);
}

/** parent의 모든 자식 나열(페이징). kind: 'folder' | 'file' | undefined(전체) */
function driveListChildren_(parentId, kind) {
  var out = [], pageToken = null;
  var mime = '';
  if (kind === 'folder') mime = " and mimeType='application/vnd.google-apps.folder'";
  else if (kind === 'file') mime = " and mimeType!='application/vnd.google-apps.folder'";
  var q = "'" + parentId + "' in parents and trashed=false" + mime;
  do {
    var res = Drive.Files.list({
      q: q, corpora: 'allDrives', supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'nextPageToken, files(id,name,mimeType,webViewLink)',
      pageSize: 100, pageToken: pageToken
    });
    if (res.files) out = out.concat(res.files);
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

function driveFolderUrl_(id) {
  return 'https://drive.google.com/drive/folders/' + id;
}

function driveFileUrl_(id) {
  return 'https://drive.google.com/file/d/' + id + '/view';
}

/* ── 시스템별 폴더 라우팅 ─────────────────────────────────────
   구조: {시스템 루트}/{NN. CODE 선박폴더}/{YYYY-MM-DD 내용 이벤트폴더}/파일 */

/** 시스템('EGCS'|'BWTS')의 저장 루트 폴더 id */
function getSystemRoot_(system) {
  var props = PropertiesService.getScriptProperties();
  if (system === 'EGCS') return props.getProperty(EGCS_ROOT_KEY) || EGCS_ROOT_FALLBACK;
  return props.getProperty(BWTS_ROOT_KEY) || BWTS_ROOT_FALLBACK;
}

/** 시스템 루트 하위 선박폴더 id (없으면 생성) */
function getShipFolder_(system, shipCode) {
  var rootId = getSystemRoot_(system);
  var name = SHIP_FOLDER[shipCode] || shipCode;
  return driveEnsureChildFolder_(rootId, name);
}

/** 선박폴더 하위 'YYYY-MM-DD 내용' 이벤트폴더 id (없으면 생성).
    같은 날짜+내용이면 한 이벤트 폴더로 묶인다. */
function getEventFolder_(system, shipCode, date, content) {
  var shipId = getShipFolder_(system, shipCode);
  var d = sanitizeName_(toDateStr_(date));
  var c = sanitizeName_(content);
  var name = [d, c].filter(Boolean).join(' ').substring(0, 100) || (shipCode + ' 기타');
  return driveEnsureChildFolder_(shipId, name);
}

/**
 * 클라이언트 base64 파일을 시스템→선박→이벤트 폴더에 저장.
 * file = { name, mimeType, dataBase64 }
 * meta = { date, system, content }
 * 반환 = { name, url, id }
 */
function uploadScan(shipCode, file, meta) {
  requireRole_('editor');
  meta = meta || {};
  var system = (meta.system === 'EGCS') ? 'EGCS' : 'BWTS';
  var eventId = getEventFolder_(system, shipCode, meta.date, meta.content);
  var bytes = Utilities.base64Decode(file.dataBase64);
  var blob = Utilities.newBlob(bytes, file.mimeType || 'application/octet-stream',
                               file.name || 'scan');
  var name = buildScanName_(eventId, shipCode, file.name, meta);
  var created = Drive.Files.create(
    { name: name, parents: [eventId] }, blob,
    { supportsAllDrives: true, fields: 'id,name,webViewLink' });
  return { name: created.name, url: created.webViewLink, id: created.id };
}

function sanitizeName_(s) {
  return String(s == null ? '' : s)
    .replace(/[\\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** 표준 스캔 파일명 생성 (parentId 안에서 동일명 충돌 시 ' (2)' 등 접미) */
function buildScanName_(parentId, shipCode, origName, meta) {
  meta = meta || {};
  var ext = '';
  var dot = String(origName || '').lastIndexOf('.');
  if (dot > 0) ext = String(origName).substring(dot);
  var base;
  if (!meta.date && !meta.system && !meta.content) {
    // 메타 없으면 원본명 유지(하위호환)
    base = sanitizeName_(String(origName || 'scan').replace(/\.[^.]+$/, '')) || 'scan';
  } else {
    // 형식: 2026.03.05_KSG_BWTS ANU  (날짜_선박_시스템 내용)
    var datePart = meta.date ? String(meta.date).replace(/-/g, '.') : '';
    var head = [datePart, shipCode].filter(Boolean).join('_');
    var tail = [meta.system || '', meta.content ? sanitizeName_(meta.content) : '']
      .filter(Boolean).join(' ');
    base = [head, tail].filter(Boolean).join('_').trim() || shipCode;
  }
  base = base.substring(0, 80);
  var name = base + ext, i = 2;
  while (driveFileExistsByName_(parentId, name)) { name = base + ' (' + i + ')' + ext; i++; }
  return name;
}

/** UI '폴더 열기' 버튼용 — 시스템별 선박폴더 URL */
function getShipFolderUrl(system, shipCode) {
  requireRole_('viewer');
  return driveFolderUrl_(getShipFolder_(system, shipCode));
}

/* ── 업로드 자동분석 (수동 업로드 PDF → 선박/날짜/시스템 제안) ──
   Drive OCR(PDF→임시 Doc)로 텍스트 추출 후 휴리스틱 파싱. 자동제출 아님,
   사용자 확인용 제안값만 반환. DocumentApp 대신 Drive.Files.export 사용해
   기존 'drive' 스코프 범위 내에서 동작. */

/** 공유드라이브 포함 파일 id의 바이트를 OAuth로 직접 다운로드 → Blob(없으면 null).
   DriveApp.getBlob()은 공유드라이브에서 빈 데이터를 주는 경우가 있어 이걸 쓴다. */
function driveGetBlob_(fileId) {
  try {
    var url = 'https://www.googleapis.com/drive/v3/files/' + fileId +
      '?alt=media&supportsAllDrives=true';
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true });
    return res.getResponseCode() === 200 ? res.getBlob() : null;
  } catch (e) { return null; }
}

// ====== BWTS 운전로그(Firestore analyses) 읽기 — 읽기 전용 ======
// 분석/판정은 BWTS 대시보드가 수행해 같은 Firebase 프로젝트(bwts-dashboard)
// Firestore에 저장한다. 여기선 owner OAuth 토큰(datastore 스코프)으로 REST 읽기만.
var FS_PROJECT = 'bwts-dashboard';
function fsBase_() {
  return 'https://firestore.googleapis.com/v1/projects/' + FS_PROJECT +
    '/databases/(default)/documents';
}
function fsDecodeVal_(v) {
  if (v == null) return null;
  if (v.nullValue !== undefined) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.mapValue !== undefined) return fsDecodeFields_(v.mapValue.fields || {});
  if (v.arrayValue !== undefined) {
    return (v.arrayValue.values || []).map(fsDecodeVal_);
  }
  return null;
}
function fsDecodeFields_(fields) {
  var o = {};
  for (var k in fields) o[k] = fsDecodeVal_(fields[k]);
  return o;
}
/** 컬렉션 경로의 문서들을 평문 객체 배열로 (_id 포함). 404=빈 컬렉션. */
function fsList_(path) {
  var out = [], token = '';
  do {
    var url = fsBase_() + path + '?pageSize=300' +
      (token ? '&pageToken=' + encodeURIComponent(token) : '');
    var res = UrlFetchApp.fetch(url, {
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 404) return out;
    if (code !== 200) {
      throw new Error('Firestore ' + code + ': ' +
        String(res.getContentText() || '').slice(0, 180));
    }
    var data = JSON.parse(res.getContentText() || '{}');
    (data.documents || []).forEach(function (doc) {
      var obj = fsDecodeFields_(doc.fields || {});
      obj._id = doc.name.split('/').pop();
      out.push(obj);
    });
    token = data.nextPageToken || '';
  } while (token);
  return out;
}
/** 통합앱 BWTS LOG 탭 — 특정 연·월 분석결과 (읽기 전용) */
function getBwtsLog(year, month) {
  requireRole_('viewer');
  var ym = year + '_' + pad2_(month);
  var vessels = fsList_('/vessels').map(function (d) {
    return {
      id: d._id, name: d.name || d._id, vesselCode: d.vesselCode || '',
      manufacturer: d.manufacturer || '', imoNumber: d.imoNumber || ''
    };
  });
  var monthly = {};
  fsList_('/analyses/' + ym + '/vessels').forEach(function (d) {
    monthly[d._id] = {
      analysisStatus: d.analysisStatus || 'NO_DATA',
      lastAnalyzed: d.lastAnalyzed || null,
      analysisResult: d.analysisResult || null,
      reviewed: !!d.reviewed,
      reviewRemark: d.reviewRemark || '',
      hasCsv: !!d.hasCsv,
      hasPdf: !!d.hasPdf
    };
  });
  return { vessels: vessels, monthly: monthly };
}

/** 권한 동의용 — Apps Script 편집기에서 이 함수를 1회 실행(▷)해
    datastore(Firestore 읽기) 스코프를 허용한다. 권한 화면에서 '허용'하면
    웹앱의 BWTS 운전로그가 열린다. (인자 없이 현재 연·월로 호출) */
function authorizeBwtsLog() {
  var d = new Date();
  return getBwtsLog(d.getFullYear(), d.getMonth() + 1);
}

/** PDF blob을 OCR(임시 Doc 변환→텍스트 추출→삭제)하여 텍스트 반환. 실패 시 ''. */
/** PDF에서 텍스트 추출. 전자 PDF → 직접 추출 시도, 실패/빈 결과 → OCR 폴백. */
function ocrPdfText_(blob) {
  // 1) 전자 PDF 직접 텍스트 추출 시도 (Gemini 멀티모달)
  var directText = extractPdfTextDirect_(blob);
  if (directText && directText.length > 50) return directText;
  // 2) OCR 폴백 (스캔본/이미지 PDF)
  var docId = null;
  try {
    var nm = (blob && blob.getName && blob.getName()) || 'scan';
    var doc = Drive.Files.create(
      { name: 'OCR_TEMP_' + nm, mimeType: 'application/vnd.google-apps.document' },
      blob, { ocrLanguage: 'ko', fields: 'id' });
    docId = doc.id;
    var out = Drive.Files.export(docId, 'text/plain');
    return (out && out.getDataAsString) ? out.getDataAsString('UTF-8') : String(out || '');
  } catch (e) {
    return '';
  } finally {
    if (docId) { try { Drive.Files.remove(docId); } catch (e2) {} }
  }
}

/** 전자 PDF(텍스트 레이어 있는 PDF)에서 Gemini로 직접 텍스트 추출.
    스캔본이면 빈 문자열 반환 → 호출부가 OCR 폴백. */
function extractPdfTextDirect_(blob) {
  if (!blob) return '';
  return geminiCall_(
    '이 PDF의 텍스트 내용을 있는 그대로 추출하라. ' +
    '포맷·줄바꿈 유지. 요약하지 말고 원문 그대로 출력. ' +
    '텍스트가 없으면 빈 문자열만 반환.',
    { pdfBlob: blob, temp: 0, maxTokens: 4000, retryOn429: true }
  );
}

/** file={name,mimeType,dataBase64} → {shipCode,date,system,content,confidence} */
function analyzeUpload(file) {
  requireRole_('editor');
  file = file || {};
  var text = '';
  try {
    var bytes = Utilities.base64Decode(file.dataBase64);
    var blob = Utilities.newBlob(bytes, file.mimeType || 'application/pdf',
                                 file.name || 'scan');
    text = ocrPdfText_(blob);
  } catch (e) {
    return { shipCode: '', date: '', system: '', content: '', confidence: 0,
             error: String(e) };
  }

  var fromName = parseEventTitle_(file.name || '');
  var fromText = parseEventTitle_(text);
  var shipCode = fromName.shipCode || fromText.shipCode ||
                 matchShipFromText_(file.name || '') || matchShipFromText_(text) || '';
  var date = fromName.date || fromText.date || '';
  var content = fromName.content ||
                (fromText.content ? fromText.content.substring(0, 60) : '');
  var system = detectSystem_((file.name || '') + '\n' + text);

  var conf = (shipCode ? 0.5 : 0) + (date ? 0.25 : 0) + (system ? 0.25 : 0);
  return { shipCode: shipCode, date: date, system: system, content: content,
           confidence: conf };
}

/** 텍스트에서 시스템 추정. 모호하면 '' (사용자 선택 유지) */
function detectSystem_(text) {
  var isE = /(EGCS|SCRUBBER|스크러버|탈황|\bWMS\b|\bCEMS\b|WASH ?WATER|다공판)/i.test(text);
  var isB = /(BWTS|BALLAST|평형수|전해|ELECTRO|D-?2|USCG)/i.test(text);
  if (isE && !isB) return 'EGCS';
  if (isB && !isE) return 'BWTS';
  return '';
}

/** 발신 도메인으로 BWTS/EGCS 판별. from 헤더 전체를 받음. */
function detectSystemByDomain_(from) {
  from = String(from || '');
  if (/techcross\.com|alfalaval\.com/i.test(from)) return 'BWTS';
  if (/unionkr\.com|hyundaimaterials\.com|hhi-power\.com|worldpanasia\.com/i.test(from)) return 'EGCS';
  return '';
}

/* ── 마이그레이션 (1회성, 관리자가 에디터에서 실행) ───────────
   순서: migrateNestEgcs({dryRun:false}) → migrateIndexReports(...). */

/** 폴더/파일 제목에서 날짜·선박·내용 추출.
    반환 { date:'yyyy-MM-dd'|'', shipCode:'KXX'|'', content:'' } */
function parseEventTitle_(title) {
  var t = String(title || '');
  var out = { date: '', shipCode: '', content: '' };
  var dm = t.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
  if (dm) out.date = dm[1] + '-' + pad2_(dm[2]) + '-' + pad2_(dm[3]);

  var codes = Object.keys(SHIP_FOLDER);
  // 1) 코드 토큰 ('KCN', 'KCN호' 등 단어경계)
  for (var i = 0; i < codes.length; i++) {
    if (new RegExp('\\b' + codes[i] + '\\b', 'i').test(t)) { out.shipCode = codes[i]; break; }
  }
  // 2) 코드 없으면 선박명('KMTC COLOMBO' 등) 매칭
  if (!out.shipCode) {
    var T = t.toUpperCase();
    for (var j = 0; j < codes.length; j++) {
      var nm = SHIP_SEED[codes[j]] && SHIP_SEED[codes[j]].name;
      if (nm && T.indexOf(nm.toUpperCase()) >= 0) { out.shipCode = codes[j]; break; }
    }
  }
  // 내용 = 제목 − 날짜 − 선박토큰
  var c = t;
  if (dm) c = c.replace(dm[0], ' ');
  if (out.shipCode) {
    c = c.replace(new RegExp('\\b' + out.shipCode + '\\b호?', 'ig'), ' ');
    var nm2 = SHIP_SEED[out.shipCode] && SHIP_SEED[out.shipCode].name;
    if (nm2) c = c.replace(new RegExp(nm2, 'ig'), ' ');
  }
  out.content = sanitizeName_(c).replace(/^[_\-\s]+|[_\-\s]+$/g, '').trim();
  return out;
}

/** 선박폴더명('NN. CODE') → 선박코드 역맵 */
function shipFolderNameMap_() {
  var m = {};
  Object.keys(SHIP_FOLDER).forEach(function (c) { m[SHIP_FOLDER[c]] = c; });
  return m;
}

/**
 * Phase 3 — EGCS 루트 직속 날짜 이벤트 폴더를 선박폴더 아래로 재배치.
 * opts.dryRun (기본 true). 실제 이동은 migrateNestEgcs({dryRun:false}).
 */
function migrateNestEgcs(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var rootId = getSystemRoot_('EGCS');
  var shipNames = shipFolderNameMap_();
  var moved = [], skipped = [], unmatched = [];

  driveListChildren_(rootId, 'folder').forEach(function (f) {
    if (shipNames[f.name]) { skipped.push(f.name); return; } // 이미 선박폴더
    var p = parseEventTitle_(f.name);
    if (!p.shipCode) { unmatched.push(f.name); return; }
    var line = f.name + '  →  ' + SHIP_FOLDER[p.shipCode];
    if (!dryRun) {
      var shipId = getShipFolder_('EGCS', p.shipCode);
      Drive.Files.update({}, f.id, null, {
        addParents: shipId, removeParents: rootId, supportsAllDrives: true, fields: 'id'
      });
    }
    moved.push(line);
  });

  var report = {
    phase: 'nestEgcs', dryRun: dryRun, movedCount: moved.length,
    skippedCount: skipped.length, unmatchedCount: unmatched.length,
    moved: moved, unmatched: unmatched
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Phase 4 — 시스템 루트의 이벤트 폴더들을 Repairs 수리이력으로 등록(인덱싱).
 * 멱등: sourceFolderId 중복 시 skip. opts.dryRun (기본 true).
 * EGCS는 migrateNestEgcs 후 실행 권장(선박폴더 하위까지 스캔하되 루트 직속도 처리).
 */
function migrateIndexReports(system, opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  system = (system === 'EGCS') ? 'EGCS' : 'BWTS';
  var rootId = getSystemRoot_(system);
  var shipNames = shipFolderNameMap_();

  var existing = {};
  readAll_('Repairs').forEach(function (r) {
    if (r.sourceFolderId) existing[String(r.sourceFolderId)] = true;
  });

  // 이벤트 폴더 수집: 선박폴더→자식 + 루트 직속(미재배치) 폴더
  var events = [];
  driveListChildren_(rootId, 'folder').forEach(function (top) {
    if (shipNames[top.name]) {
      var code = shipNames[top.name];
      driveListChildren_(top.id, 'folder').forEach(function (ev) {
        events.push({ id: ev.id, name: ev.name, shipCode: code });
      });
    } else {
      events.push({ id: top.id, name: top.name, shipCode: parseEventTitle_(top.name).shipCode });
    }
  });

  var added = [], skipped = [], unmatched = [];
  events.forEach(function (ev) {
    if (existing[ev.id]) { skipped.push(ev.name); return; }
    if (!ev.shipCode) { unmatched.push(ev.name); return; }
    var p = parseEventTitle_(ev.name);
    var content = p.content || ev.name;
    var files = driveListChildren_(ev.id, 'file');
    var atts = [{ name: '📁 ' + ev.name, url: driveFolderUrl_(ev.id), id: ev.id }];
    files.slice(0, 20).forEach(function (fl) {
      atts.push({ name: fl.name, url: fl.webViewLink || driveFileUrl_(fl.id), id: fl.id });
    });
    if (!dryRun) {
      addRepair({
        id: 'MIG_' + ev.id, shipCode: ev.shipCode, system: system, date: p.date || '',
        equip: content, stage: 'done', symptom: '', action: '',
        attachments: atts, sourceFolderId: ev.id
      });
    }
    added.push(ev.shipCode + ' | ' + (p.date || '날짜?') + ' | ' + content +
               ' (파일 ' + files.length + ')');
  });

  if (!dryRun && added.length) { try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); } }

  var report = {
    phase: 'indexReports', system: system, dryRun: dryRun,
    addedCount: added.length, skippedCount: skipped.length,
    unmatchedCount: unmatched.length, added: added, unmatched: unmatched
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ── 마이그레이션 실행 래퍼 (에디터에서 인자 없이 클릭 실행) ──
   에디터 '실행' 버튼은 함수 인자를 못 넘기므로 dryRun/실제 버전을 분리.
   순서: ① run_nestEgcs_DRY → ② run_nestEgcs_REAL
        ③ run_indexEGCS_DRY → ④ run_indexEGCS_REAL
        ⑤ run_indexBWTS_DRY → ⑥ run_indexBWTS_REAL.
   결과는 보기>실행 로그(Ctrl+Enter)에서 확인. */
function run_nestEgcs_DRY()   { return migrateNestEgcs({ dryRun: true }); }
function run_nestEgcs_REAL()  { return migrateNestEgcs({ dryRun: false }); }
function run_indexEGCS_DRY()  { return migrateIndexReports('EGCS', { dryRun: true }); }
function run_indexEGCS_REAL() { return migrateIndexReports('EGCS', { dryRun: false }); }
function run_indexBWTS_DRY()  { return migrateIndexReports('BWTS', { dryRun: true }); }
function run_indexBWTS_REAL() { return migrateIndexReports('BWTS', { dryRun: false }); }

/** 일회성 — 날짜 미인식 2건 보정 (PDF 본문에서 확인한 검교정일). */
function run_fixDates() {
  updateRepair('MIG_1iJeV4syUl2HQ0723Pa_geJx7-d6jzRpZ', { date: '2026-01-02' }); // KUS 연간검교정
  updateRepair('MIG_1GxBVQJT-DzrTNLnneN-s6obOeVPoWAbN', { date: '2025-10-10' }); // KSH SENSOR CAL
  return 'fixed: KUS 2026-01-02, KSH 2025-10-10';
}

/** 빈 이벤트 폴더 정리 (1회성, 에디터 실행).
   BWTS/EGCS 루트 → 선박폴더 → 이벤트폴더 순회.
   파일이 0개인 폴더를 삭제(또는 dryRun시 목록만).
   특히 날짜 없는 "Annual Calibration" 빈 폴더 대상.
   실행: run_cleanEmpty_DRY() → 확인 → run_cleanEmpty_REAL() */
function cleanEmptyFolders_(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var removed = [], kept = [];

  ['BWTS', 'EGCS'].forEach(function (sys) {
    var rootId = getSystemRoot_(sys);
    driveListChildren_(rootId, 'folder').forEach(function (ship) {
      driveListChildren_(ship.id, 'folder').forEach(function (ev) {
        var files = driveListChildren_(ev.id, 'file');
        var subs = driveListChildren_(ev.id, 'folder');
        if (files.length === 0 && subs.length === 0) {
          removed.push(sys + '/' + ship.name +
            '/' + ev.name);
          if (!dryRun) {
            try {
              Drive.Files.update(
                { trashed: true }, ev.id,
                null, { supportsAllDrives: true });
            } catch (e) {
              Logger.log('trash fail: ' + ev.name +
                ' ' + e);
            }
          }
        } else {
          kept.push(sys + '/' + ship.name +
            '/' + ev.name + ' (' + files.length +
            ' files)');
        }
      });
    });
  });

  var report = {
    dryRun: dryRun,
    removedCount: removed.length,
    removed: removed,
    keptCount: kept.length
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}
function run_cleanEmpty_DRY() {
  return cleanEmptyFolders_({ dryRun: true });
}
function run_cleanEmpty_REAL() {
  return cleanEmptyFolders_({ dryRun: false });
}

/** 1회성 — KJA/KPS 서비스리포트 수동 등록 (2026.07.03).
   Drive에 이미 복사됨, DB에 등록 + 폴더 링크 연결. */
function run_importManualReports() {
  var bwtsRoot = getSystemRoot_('BWTS');

  // KJA: FMU Inspection 2026-03-18
  var kjaFid = getEventFolder_(
    'BWTS', 'KJA', '2026-03-18', 'FMU Inspection');
  var kjaFiles = driveListChildren_(kjaFid, 'file');
  var kjaAtts = [{ name: '폴더: FMU Inspection',
    url: driveFolderUrl_(kjaFid), id: kjaFid }];
  kjaFiles.forEach(function (f) {
    kjaAtts.push({ name: f.name,
      url: f.webViewLink || driveFileUrl_(f.id),
      id: f.id });
  });
  addRepair({
    id: 'MAN_KJA_20260318',
    shipCode: 'KJA', system: 'BWTS',
    date: '2026-03-18',
    equip: 'FMU Inspection',
    stage: 'done',
    symptom: 'FMU HM2 Fail',
    action: 'FMU bridge 교체, Sol.Valve overhaul, ' +
      'APU overhaul, Sensor calibration, ' +
      'CLX Reagent 점검 (TechCross)',
    attachments: kjaAtts,
    sourceFolderId: kjaFid
  });

  // KPS: ECU Trip + CPC Fail 2026-03-07
  var kpsFid = getEventFolder_(
    'BWTS', 'KPS', '2026-03-07', 'ECU Trip CPC Fail');
  var kpsFiles = driveListChildren_(kpsFid, 'file');
  var kpsAtts = [{ name: '폴더: ECU Trip CPC Fail',
    url: driveFolderUrl_(kpsFid), id: kpsFid }];
  kpsFiles.forEach(function (f) {
    kpsAtts.push({ name: f.name,
      url: f.webViewLink || driveFileUrl_(f.id),
      id: f.id });
  });
  addRepair({
    id: 'MAN_KPS_20260307',
    shipCode: 'KPS', system: 'BWTS',
    date: '2026-03-07',
    equip: 'ECU / CPC',
    stage: 'done',
    symptom: 'ECU Emergency trip (High temp/pressure)' +
      ', Local CPC communication fail, LOG 지연',
    action: '온도스위치 교체, LAN 포트 이동' +
      '(LAN2→LAN1), 로그 삭제+HMI 업데이트, ' +
      'Ballast/Deballast 정상 확인 (TechCross)',
    attachments: kpsAtts,
    sourceFolderId: kpsFid
  });

  try { exportSnapshot(); } catch (e) {
    Logger.log('snapshot: ' + e);
  }
  return 'KJA + KPS registered';
}

/* ════════════════════════════════════════════════════════════
   Gmail 서비스리포트/인증서 자동수집
   메일 첨부(인증서·서비스리포트)를 Drive에 저장 + 수리이력 등록.
   5층 중복방지로 미적용분만 추가. 항상 dryRun 먼저.
   실행: run_collectGmail_DRY() → 검토 → run_collectGmail_REAL()
   ════════════════════════════════════════════════════════════ */

var GMAIL_SCAN_WINDOW = 'newer_than:3y';
var GMAIL_BATCH_MSGS = 60;        // 1회 처리 메시지 상한(6분 제한 회피)
var TRIGGER_LIMIT_SEC = 330;      // 6분 제한 중 안전 마진(5.5분)

/** t0=Date.now() 기준 남은 초 반환 (트리거 6분 제한용) */
function getRemainingTime_(t0) {
  return TRIGGER_LIMIT_SEC - (Date.now() - t0) / 1000;
}
var GMDONE_PREFIX = 'GMDONE_';    // 처리완료 메시지 표시(ScriptProperties)
var GMDONE_FAIL_PREFIX = 'GMFAIL_'; // 실패 횟수 추적(3회 초과 시 스킵)
var GMDONE_MAX_RETRY = 3;
var GMAIL_CURSOR_KEY = 'GMAIL_CURSOR';
var DUP_DAYS = 7;                 // 선박+시스템 중복 판정 ±일수

/** Gmail 메시지 → 웹 링크(클릭 시 Gmail에서 해당 메일 열림).
    GmailMessage.getId()는 hex ID → #inbox/<id> 형식으로 직접 접근 가능. */
function gmailMessageUrl_(msg) {
  try {
    var thId = msg.getThread().getId();
    return 'https://mail.google.com/mail/u/0/#inbox/' + thId;
  } catch (e) {
    return '';
  }
}

/** 소스별 Gmail 검색 쿼리(벤더 도메인 기반).
    각 소스는 collectGmail의 sysMap으로 BWTS/EGCS 자동 분류된다. */
function gmailQueries_(window) {
  var w = window || GMAIL_SCAN_WINDOW;
  var ex = ' -from:ekmtc.com' +                    // 본인/회사 발신 제외
           ' -subject:(invoice OR quotation OR quotaiton OR 견적 OR 송장 OR ' +
           '계산서 OR 정산 OR 발주 OR draft OR packing OR 인보이스 OR 비용 OR ' +
           'INQUIRY OR 기부속 OR 수리자재 OR 전달의 OR 문의)' +
           // 본선 월간 BWTS LOG/BWRB 송부 메일 제외 — 4. BWTS LOG DATA 로
           // 별도 GAS(TOTAL AUTO LABELLING/saveBwtsLogs)가 저장한다.
           ' -subject:("BWTS LOG" OR "LOG DATA" OR "DATA LOG" OR BWRB OR ' +
           'BWTS_LOG_DATA OR "LOG FILE")';
  // 서비스리포트/인증서 관련 제목 키워드(공통)
  var svcKw = ' subject:("Service report" OR Certificate OR ' +
    'Calibration OR 수리 OR 조치 OR 교체 OR 점검 OR report OR ' +
    '서비스 OR inspection OR commissioning)';
  return {
    // ── BWTS 벤더 ──
    techcross:
      'from:techcross.com has:attachment ' +
      '(filename:pdf OR filename:zip) ' + w +
      ' subject:("Sensor Calibration" OR "Calibration Cert" OR ' +
      '"Calibration Certificate" OR USCG OR "Service report" OR ' +
      '"S/W" OR 수리 OR 조치 OR 교체 OR 점검)' + ex,
    alfalaval:
      'from:alfalaval.com has:attachment ' +
      '(filename:pdf OR filename:zip) ' + w +
      ' subject:("Service report" OR Certificate OR ' +
      'Calibration OR CSP OR BWTS OR "PureBallast")' +
      ' -subject:(boiler OR separator OR heat OR lube)' + ex,

    // ── EGCS 벤더 (첨부 있는 메일) ──
    union:
      'from:unionkr.com has:attachment ' +
      '(filename:pdf OR filename:zip) ' + w + svcKw + ex,
    hyundai_material:
      'from:hyundaimaterials.com has:attachment ' +
      '(filename:pdf OR filename:zip) ' + w + svcKw + ex,
    hps:
      'from:hhi-power.com has:attachment ' +
      '(filename:pdf OR filename:zip) ' + w + svcKw + ex,
    panasia:
      'from:worldpanasia.com has:attachment ' +
      '(filename:pdf OR filename:zip) ' + w + svcKw + ex,

    // ── 벤더 텍스트 메일 (첨부 없어도 본문 기반 수집) ──
    vendor_text:
      '(from:unionkr.com OR from:hyundaimaterials.com OR ' +
      'from:hhi-power.com OR from:worldpanasia.com OR ' +
      'from:techcross.com OR from:alfalaval.com) ' +
      '-has:attachment ' + w + svcKw + ex,

    // ── 기타(도메인 무관, 키워드 기반) ──
    egcs_general:
      'has:attachment (filename:pdf OR filename:zip) ' + w +
      ' -from:techcross.com -from:alfalaval.com' +
      ' -from:unionkr.com -from:hyundaimaterials.com' +
      ' -from:hhi-power.com -from:worldpanasia.com' +
      ' subject:(scrubber OR 스크러버 OR 다공판 OR ' +
      'CEMS OR EGCS OR WMS)' + ex,
    bwts_general:
      'has:attachment (filename:pdf OR filename:zip) ' + w +
      ' -from:techcross.com -from:alfalaval.com' +
      ' -from:unionkr.com -from:hyundaimaterials.com' +
      ' -from:hhi-power.com -from:worldpanasia.com' +
      ' subject:(BWTS OR "ballast water" OR 평형수 OR ' +
      'USCG OR "type approval")' + ex
  };
}

/** 제목에서 머리말/수신자/hull번호/잡음 제거 → 깔끔한 내용(장비) 추출 */
function cleanSubject_(s) {
  s = String(s || '');
  s = s.replace(/\[[^\]]*\]/g, ' ');                  // [Follow Up Email] 등
  s = s.replace(/\b(re|fw|fwd)\s*:/ig, ' ');          // Re:/Fw:
  s = s.replace(/Follow\s*Up\s*Email/ig, ' ');
  s = s.replace(/KMTC\s*SM\s*ETP|정현우\s*과장님?|과장님?/g, ' ');
  s = s.replace(/\(ALK[^)]*\)/ig, ' ');               // (ALK OD ...) 주문번호
  s = s.replace(/\bKMTC\s+[A-Za-z]+/g, ' ');          // KMTC DUBAI 등 선박 풀네임
  s = s.replace(/\(\d{3,4}\)/g, ' ');                 // (4062) hull
  s = s.replace(/호선|\b호\b/g, ' ');
  s = s.replace(/[\/]+/g, ' ');                        // 구분자
  // 잡음 문구 제거 (넓은 패턴 먼저)
  s = s.replace(/부산\s*(방선\s*)?일정\s*(\([^)]*\)\s*)?(방선\s*)?진행\s*관련\s*/g, ' ');
  s = s.replace(/방선\s*일정\s*진행\s*관련/g, ' ');
  s = s.replace(/견적\s*건|전달의?\s*건|송부\s*건|관련\s*건|진행\s*관련/g, ' ');
  s = s.replace(/Service\s*Report\s*송부/ig, 'Service Report');
  s = s.replace(/\.\s*$/, '');                         // 끝 마침표
  return sanitizeName_(s).substring(0, 50);
}

/** 쿼리로 메시지 평탄화 수집(스레드 상한 페이징) */
function gmailSearchMessages_(query, maxThreads) {
  maxThreads = maxThreads || 300;
  var out = [], start = 0, page = 100;
  while (start < maxThreads) {
    var threads = GmailApp.search(query, start, Math.min(page, maxThreads - start));
    if (!threads.length) break;
    for (var i = 0; i < threads.length; i++) {
      var msgs = threads[i].getMessages();
      for (var j = 0; j < msgs.length; j++) out.push(msgs[j]);
    }
    if (threads.length < page) break;
    start += page;
  }
  return out;
}

/** 첨부 분류: 비즈니스 문서(인보이스/견적 등) 제외, 나머지 전부 저장.
   kind: 'cert'|'report'|'file'. {keep,kind} */
function gmailClassifyAttachment_(att) {
  var n = att.getName() || '';
  // 비즈니스 문서·로고·서명 제외
  if (/(invoice|quotation|quotaiton|견적|송장|계산서|정산|발주|packing|draft)/i.test(n) ||
      /(INQUIRY|ORDER\s*SHEET|기부속|수리자재)/i.test(n) ||
      /(logo|signature|광고|banner)/i.test(n)) {
    return { keep: false, kind: '' };
  }
  // 인라인 이미지(cid) 제외 — 서명/로고 이미지
  var ct = att.getContentType ? att.getContentType() : '';
  if (/^image\//i.test(ct) && att.getSize() < 30000) {
    return { keep: false, kind: '' };
  }
  // 대표파일 분류
  if (/(certificate|sensor\s*calibration|calibration\s*cert|tech[-\s]?\d{3,}|\bcert\b|csp|uscg)/i.test(n)) {
    return { keep: true, kind: 'cert' };
  }
  if (/service\s*report|서비스\s*리포트|AS\s*report/i.test(n)) {
    return { keep: true, kind: 'report' };
  }
  return { keep: true, kind: 'file' };
}

/** 텍스트에서 선박코드 추출 (통합 파서).
   코드 토큰 → 풀네임(KMTC XXX) → 도시명/오타(MUNDRA, SOEUL 등).
   allowCity=true면 도시명까지 매칭(유일할 때만 확정). */
var CITY_TYPO_MAP_ = {
  'SOEUL':'KSL','NHAVA':'KNH','JEBAL':'KJA'
};
function parseShipCode_(text, allowCity) {
  text = String(text || '');
  if (!text) return '';
  var T = text.toUpperCase();
  var codes = Object.keys(SHIP_FOLDER);
  var hits = {};
  codes.forEach(function (c) {
    if (new RegExp('\\b' + c + '\\b', 'i').test(text)) {
      hits[c] = 1; return;
    }
    var nm = SHIP_SEED[c] && SHIP_SEED[c].name;
    if (!nm) return;
    var NM = nm.toUpperCase();
    if (new RegExp('\\b' + NM.replace(/\s+/g, '\\s+') +
        '\\b').test(T)) { hits[c] = 1; return; }
    if (allowCity) {
      var city = NM.replace(/^KMTC\s+/, '');
      if (city.length >= 5 &&
          new RegExp('\\b' + city.replace(/\s+/g, '\\s+') +
            '\\b').test(T)) hits[c] = 1;
    }
  });
  // 오타 매칭 (allowCity일 때)
  if (allowCity && !Object.keys(hits).length) {
    var typos = Object.keys(CITY_TYPO_MAP_);
    for (var t = 0; t < typos.length; t++) {
      if (T.indexOf(typos[t]) >= 0) {
        hits[CITY_TYPO_MAP_[typos[t]]] = 1; break;
      }
    }
  }
  var found = Object.keys(hits);
  return found.length === 1 ? found[0] : '';
}
/** @deprecated — use parseShipCode_ */
function matchShipFromText_(text, allowCity) {
  return parseShipCode_(text, allowCity);
}

/** 본문에서 인용·서명·원문이하를 잘라낸 상단 텍스트(서명·주소 도시명 오매칭 방지). */
function emailBodyTop_(msg) {
  var body = '';
  try { body = msg.getPlainBody() || ''; } catch (e) { return ''; }
  var cuts = [/\n-{2,}\s*\n/, /\n_{5,}/, /\nFrom:\s/i, /\n보낸\s*사람\s*:/, /\n발신:/,
    /\nOn .{0,80}\bwrote:/i, /\n.{0,40}님이\s*작성/, /\n-{3,}\s*Original/i,
    /\nSent from /i, /\nGet Outlook/i];
  var end = body.length;
  cuts.forEach(function (re) {
    var m = body.match(re);
    if (m && m.index >= 0 && m.index < end) end = m.index;
  });
  return body.slice(0, Math.min(end, 3000));
}

/** 메시지 → {shipCode,date,content,system} */
function gmailParseMessageMeta_(msg, defaultSystem) {
  var subject = msg.getSubject() || '';
  var p = parseEventTitle_(subject);
  var ship = p.shipCode;                              // 제목의 코드/풀네임(가장 신뢰)
  if (!ship) ship = matchShipFromText_(subject, true);  // 제목: 도시명까지 허용(유일할 때만)
  if (!ship) {
    // 본문 상단(인용·서명 제외): 내용을 읽어 코드/풀네임/도시명까지 매칭(유일할 때만)
    ship = matchShipFromText_(emailBodyTop_(msg), true);
  }
  var from = '';
  try { from = msg.getFrom() || ''; } catch (ef) {}
  var system;
  var domainSys = detectSystemByDomain_(from);
  if (domainSys) system = domainSys;
  else system = defaultSystem || detectSystem_(subject) || 'BWTS';
  var date = p.date;
  if (!date) {
    try { date = Utilities.formatDate(msg.getDate(), 'Asia/Seoul', 'yyyy-MM-dd'); }
    catch (e2) { date = ''; }
  }
  var content = cleanSubject_(subject) || (p.content || '').substring(0, 50);
  return { shipCode: ship || '', date: date, content: content, system: system };
}

/** 첨부를 시스템→선박→이벤트 폴더에 저장. {name,url,id} / null(중복) */
function gmailSaveAttachment_(system, shipCode, date, content, att) {
  var eventId = getEventFolder_(system, shipCode, date, content);
  var orig = att.getName() || 'scan.pdf';
  // 표준 파일명(날짜_선박_시스템 내용) 적용 + 동일명 충돌 시 자동 접미.
  // 같은 메일 재처리는 L2(GMDONE)·L3(sourceMsgId)가 막으므로 별도 디스크 중복검사 불필요.
  var name = buildScanName_(eventId, shipCode, orig,
    { date: date, system: system, content: content });
  var created = Drive.Files.create(
    { name: name, parents: [eventId] }, att.copyBlob(),
    { supportsAllDrives: true, fields: 'id,name,webViewLink' });
  return { name: created.name, url: created.webViewLink, id: created.id };
}

/** 선박+시스템+날짜(±DUP_DAYS)+장비 근접 레코드(attachments 배열로 파싱). 없으면 null.
    equip(장비)가 다르면 같은 선박·날짜라도 별건 처리(KSG FMU ≠ KSG WMS 등). */
function gmailFindDuplicateRepair_(shipCode, system, date, equip) {
  date = toDateStr_(date);   // Date/문자열 혼재 방지(같은 기준으로 비교)
  if (!date) return null;
  var target = new Date(date + 'T00:00:00Z').getTime();
  if (isNaN(target)) return null;
  var equipNorm = String(equip || '').replace(/\s+/g, ' ').trim().toLowerCase();
  var best = null, bestDiff = 1e15;
  readAll_('Repairs').forEach(function (r) {
    if (r.shipCode !== shipCode || (r.system || 'BWTS') !== system) return;
    // 장비명이 둘 다 있으면 비교 — 다르면 별건
    var rEquip = String(r.equip || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (equipNorm && rEquip && equipNorm !== rEquip) return;
    var t = new Date(toDateStr_(r.date) + 'T00:00:00Z').getTime();
    if (isNaN(t)) return;
    var diff = Math.abs(t - target) / 86400000;
    if (diff <= DUP_DAYS && diff < bestDiff) {
      bestDiff = diff;
      try { r.attachments = r.attachments ? JSON.parse(r.attachments) : []; }
      catch (e) { r.attachments = []; }
      best = r;
    }
  });
  return best;
}

/* ── Gemini 자동 요약 ──────────────────────────────────────────
   PDF OCR 텍스트를 Gemini API로 보내 서비스리포트/인증서 핵심을 한국어 요약.
   API 키는 ScriptProperties 'GEMINI_API_KEY'에 저장(코드에 박지 않음).
   키 없거나 실패 시 ''(빈문자열) 반환 → 호출부는 기본 문구로 폴백. */
var GEMINI_KEY_PROP = 'GEMINI_API_KEY';
var GEMINI_MODEL = 'gemini-3-flash-preview';   // 무료 확인됨. 대안: gemini-3.5-flash

/** Gemini API 공통 호출 헬퍼.
   opts: {model, temp, maxTokens, pdfBlob, retryOn429, retrySleep}
   반환: 응답 텍스트(문자열) 또는 '' (실패 시) */
function geminiCall_(prompt, opts) {
  opts = opts || {};
  var key = PropertiesService.getScriptProperties()
    .getProperty(GEMINI_KEY_PROP);
  if (!key) return '';
  var model = opts.model || GEMINI_MODEL;
  var url = 'https://generativelanguage.googleapis.com' +
    '/v1beta/models/' + model +
    ':generateContent?key=' + encodeURIComponent(key);
  var parts = [];
  if (opts.pdfBlob) {
    var b64;
    try {
      b64 = Utilities.base64Encode(opts.pdfBlob.getBytes());
    } catch (e) { return ''; }
    parts.push({ inline_data: {
      mime_type: 'application/pdf', data: b64 } });
  }
  parts.push({ text: prompt });
  var payload = {
    contents: [{ parts: parts }],
    generationConfig: {
      temperature: opts.temp != null ? opts.temp : 0.1,
      maxOutputTokens: opts.maxTokens || 300
    }
  };
  var maxAttempts = opts.retryOn429 !== false ? 2 : 1;
  var sleepMs = opts.retrySleep || 15000;
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      var res = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify(payload),
        muteHttpExceptions: true });
      var code = res.getResponseCode();
      if (code === 429 && attempt === 0) {
        Utilities.sleep(sleepMs); continue;
      }
      if (code !== 200) return '';
      var j = JSON.parse(res.getContentText());
      var out = j && j.candidates && j.candidates[0] &&
        j.candidates[0].content &&
        j.candidates[0].content.parts &&
        j.candidates[0].content.parts[0] &&
        j.candidates[0].content.parts[0].text;
      return (out || '').trim();
    } catch (e) { return ''; }
  }
  return '';
}

function geminiSummarize_(text, meta) {
  text = String(text || '').trim();
  if (!text) return '';
  meta = meta || {};
  var prompt =
    '아래는 선박 ' + (meta.shipCode || '') + ' 의 ' +
    (meta.system || '') +
    ' 서비스리포트/인증서에서 추출한 텍스트다.' +
    ' 한국어로 핵심만 3~5줄 요약하라.\n' +
    '- 점검·교정한 장비/항목\n- 발견된 이상(있으면)\n' +
    '- 수행한 조치·결과\n- 다음 권고/기한(있으면)\n' +
    '머리말·인사말 없이 항목만 간결하게.\n\n' +
    text.substring(0, 12000);
  return geminiCall_(prompt, {
    temp: 0.2, maxTokens: 400, retryOn429: false
  });
}

/** PDF blob을 Gemini에 직접 전송해 요약(OCR 불필요, 멀티모달).
   429면 20초 후 1회 재시도. 키 없거나 실패 시 ''. */
function geminiSummarizePdf_(blob, meta) {
  if (!blob) return '';
  meta = meta || {};
  var prompt =
    '첨부 PDF는 선박 ' + (meta.shipCode || '') + ' 의 ' +
    (meta.system || '') +
    ' 서비스리포트/인증서다.\n' +
    '아래 형식으로 한국어 요약하라 (각 항목 1줄):\n' +
    '장비: (점검/교정 대상 장비명)\n' +
    '증상: (결함/사유, 없으면 "정기점검")\n' +
    '조치: (수행한 작업, 교체 부품 포함)\n' +
    '결과: (정상/이상, 다음 권고 있으면 포함)\n' +
    '머리말·인사말 없이 항목만 간결하게.';
  return geminiCall_(prompt, {
    temp: 0.2, maxTokens: 500, pdfBlob: blob, retrySleep: 20000
  });
}

/** Gemini 키 1회 설정용 — 스크립트 속성 UI 대신 여기서 입력.
   아래 따옴표('') 안에 AIza... 키를 붙여넣고 이 함수를 실행한 뒤,
   보안을 위해 다시 따옴표를 비워서 저장(Ctrl+S)하면 된다. */
function setGeminiKey() {
  var KEY = '';   // ← 여기 따옴표 안에 키 붙여넣기
  if (!KEY) return '키를 따옴표 안에 넣고 다시 실행하세요';
  PropertiesService.getScriptProperties().setProperty(GEMINI_KEY_PROP, KEY.trim());
  return 'GEMINI_API_KEY 저장 완료 (이제 따옴표를 다시 비우세요)';
}

/** Gemini 키 1개만 삭제(재입력 시). */
function clearGeminiKey() {
  PropertiesService.getScriptProperties().deleteProperty(GEMINI_KEY_PROP);
  return 'GEMINI_API_KEY 삭제됨';
}

/** Gemini 원시 응답 진단 — HTTP 코드 + 본문 그대로 로그. 실패 원인 파악용. */
function run_geminiDebug() {
  var key = PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP);
  if (!key) { Logger.log('NO KEY'); return 'NO KEY'; }
  var out = {};
  // 1) 사용 가능한 모델 목록
  try {
    var lr = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models?key=' + encodeURIComponent(key),
      { muteHttpExceptions: true });
    out.listCode = lr.getResponseCode();
    var lj = JSON.parse(lr.getContentText());
    out.models = (lj.models || []).map(function (m) { return m.name; });
  } catch (e) { out.listErr = String(e); }
  // 2) generateContent 호출 원시 응답
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
    GEMINI_MODEL + ':generateContent?key=' + encodeURIComponent(key);
  var payload = { contents: [{ parts: [{ text: '안녕? 한 줄로 답해.' }] }] };
  try {
    var r = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify(payload), muteHttpExceptions: true });
    out.genCode = r.getResponseCode();
    out.genBody = r.getContentText().substring(0, 1500);
  } catch (e2) { out.genErr = String(e2); }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** 후보 모델들을 차례로 호출해 무료로 200 주는 모델 찾기. {model: code/요약} */
function run_geminiPickModel() {
  var key = PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP);
  if (!key) return 'NO KEY';
  var candidates = [
    'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.1-flash-lite',
    'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-flash-latest',
    'gemini-flash-lite-latest', 'gemma-4-26b-a4b-it'
  ];
  var out = {};
  candidates.forEach(function (m) {
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + m +
      ':generateContent?key=' + encodeURIComponent(key);
    try {
      var r = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json',
        payload: JSON.stringify({ contents: [{ parts: [{ text: '한 단어로 답: 안녕?' }] }] }),
        muteHttpExceptions: true });
      var code = r.getResponseCode();
      if (code === 200) {
        var j = JSON.parse(r.getContentText());
        var t = j && j.candidates && j.candidates[0] && j.candidates[0].content &&
          j.candidates[0].content.parts && j.candidates[0].content.parts[0] &&
          j.candidates[0].content.parts[0].text;
        out[m] = '200 OK: ' + (t || '').substring(0, 40);
      } else {
        out[m] = code + ' ' + r.getContentText().substring(0, 80);
      }
    } catch (e) { out[m] = 'ERR ' + String(e); }
  });
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** Gemini 키 설정 확인 + 짧은 테스트 호출(편집기 클릭 실행). */
function run_checkGemini() {
  var key = PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP);
  var rep = { keySet: !!key, model: GEMINI_MODEL };
  if (key) {
    rep.testSummary = geminiSummarize_(
      'Sensor calibration completed. pH sensor S/N 12345 calibrated, within spec. ' +
      'No abnormality. Next calibration due in 24 months.',
      { shipCode: 'TEST', system: 'BWTS' });
  }
  Logger.log(JSON.stringify(rep, null, 2));
  return rep;
}

/** 본선 월간 BWTS LOG / BWRB 송부 메일 판정 (수리이력 수집 제외 대상) */
function isBwtsLogMail_(subject) {
  var s = String(subject || '');
  return /BWTS[\s_]*(DATA[\s_]*)?LOG|LOG[\s_]*DATA|BWTS[\s_]*LOG[\s_]*FILE|BWRB|BALLAST\s*WATER\s*RECORD|MONTHLY[\s_]*BWTS/i.test(s);
}

/** 메시지 1건 처리(5층 중복방지). 반환 {status,...} */
function gmailRegisterMessage_(msg, opts) {
  opts = opts || {};
  var props = PropertiesService.getScriptProperties();
  var msgId = msg.getId();
  if (!opts.shipCode && !opts.force && props.getProperty(GMDONE_PREFIX + msgId)) return { status: 'done-cached' }; // L2 (수동지정·재처리 시 우회)
  // 본선 월간 BWTS LOG/BWRB 송부 메일은 수리이력 아님 → 저장 안 함(수동 지정 시 예외).
  // Gmail 검색은 언더바 제목([KPS]_BWTS_LOG_DATA_(2026.07))을 못 걸러서 여기서 한 번 더.
  if (!opts.shipCode && isBwtsLogMail_(msg.getSubject())) {
    if (!opts.dryRun) props.setProperty(GMDONE_PREFIX + msgId, 'LOG');
    return { status: 'skipped-log' };
  }

  var meta = gmailParseMessageMeta_(msg, opts.defaultSystem);
  if (opts.shipCode) meta.shipCode = opts.shipCode;   // 수동 지정(리포트 드롭다운) 우선
  if (opts.system) meta.system = opts.system;

  var atts = msg.getAttachments(), keep = [];
  // zip 첨부 → 내부 파일 추출 후 분류
  var expanded = [];
  for (var zi = 0; zi < atts.length; zi++) {
    var zn = atts[zi].getName() || '';
    if (/\.zip$/i.test(zn)) {
      try {
        var unzipped = Utilities.unzip(atts[zi]);
        for (var uz = 0; uz < unzipped.length; uz++)
          expanded.push(unzipped[uz]);
      } catch (ze) {
        Logger.log('unzip fail: ' + zn + ' ' + ze);
        expanded.push(atts[zi]); // zip 풀기 실패 시 원본 유지
      }
    } else {
      expanded.push(atts[zi]);
    }
  }
  for (var i = 0; i < expanded.length; i++) {
    if (gmailClassifyAttachment_(expanded[i]).keep)
      keep.push(expanded[i]);
  }
  if (!keep.length && opts.shipCode) {   // 수동 등록: 분류 실패해도 인보이스 외 PDF는 첨부
    for (var ii = 0; ii < expanded.length; ii++) {
      var nn = expanded[ii].getName() || '';
      if (/\.pdf$/i.test(nn) && !/(invoice|인보이스|송장|견적|quotation|계산서)/i.test(nn)) keep.push(expanded[ii]);
    }
  }
  var hasAttachments = keep.length > 0;

  // 첫 PDF는 1회만 텍스트 추출해서 선박 추론·요약에 공용으로 사용
  var ocrText = null;
  var ocrFirst_ = function () {
    if (ocrText === null) {
      if (keep.length) {
        try { ocrText = ocrPdfText_(keep[0].copyBlob()) || ''; } catch (e) { ocrText = ''; }
      } else {
        ocrText = '';
      }
    }
    return ocrText;
  };

  // 제목/본문으로 선박 못 잡으면 첨부 PDF 텍스트에서 선박·날짜 분석
  if (!meta.shipCode && !opts.noOcr) {
    // 메일 본문에서 먼저 시도
    if (!meta.shipCode) {
      var bodyText = emailBodyTop_(msg);
      var s1 = matchShipFromText_(bodyText, true);
      if (s1) meta.shipCode = s1;
    }
    // PDF에서 시도
    if (!meta.shipCode && keep.length) {
      var txt = ocrFirst_();
      var s2 = matchShipFromText_(txt, true);
      if (s2) {
        meta.shipCode = s2;
        if (!meta.date) {
          var dm = txt.match(/(\d{4})\D(\d{1,2})\D(\d{1,2})/);
          if (dm) meta.date = dm[1] + '-' + pad2_(dm[2]) + '-' + pad2_(dm[3]);
        }
      }
    }
  }
  if (!meta.shipCode) {
    if (!opts.dryRun) props.setProperty(GMDONE_PREFIX + msgId, '1');
    return { status: 'unmatched', subject: msg.getSubject() };
  }

  // 첨부 없는 메일: 본문 기반으로 등록 (벤더 도메인 메일이면 의미 있는 내용)
  if (!hasAttachments) {
    if (!opts.allowTextOnly) {
      if (!opts.dryRun) props.setProperty(GMDONE_PREFIX + msgId, '1');
      return { status: 'no-cert', subject: msg.getSubject() };
    }
  }

  var thId = '';
  try { thId = msg.getThread().getId(); } catch (eT) { thId = ''; }
  var all = readAll_('Repairs');           // L3: sourceMsgId / 같은 스레드+제목 중복
  for (var k = 0; k < all.length; k++) {
    var srcK = String(all[k].sourceMsgId);
    // prefix(etp:/mkr:) 제거 후 순수 msgId 추출
    var srcPure = srcK.split(' ')[0]
      .replace(/^etp:/, '').replace(/^mkr:/, '');
    // 같은 메시지(기존행 호환) 또는 같은 스레드의 같은 제목(원본+Re/Fw 형제) → 중복
    var hitMsg = srcPure === msgId || srcK.indexOf(msgId + ' @thread:') === 0;
    var hitThread = !!thId && srcK.indexOf('@thread:' + thId) >= 0 &&
                    String(all[k].equip || '') === String(meta.content || '');
    if (hitMsg || hitThread) {
      if (!opts.dryRun) props.setProperty(GMDONE_PREFIX + msgId, '1');
      return { status: 'already-registered', shipCode: meta.shipCode };
    }
  }

  var line = meta.shipCode + ' | ' + meta.date + ' | ' + meta.content +
             ' (첨부 ' + keep.length + ')';
  if (opts.dryRun) return { status: 'would-add', line: line, system: meta.system };

  var saved = [];
  keep.forEach(function (a) {
    var r = gmailSaveAttachment_(meta.system, meta.shipCode, meta.date, meta.content, a);
    if (r && r.id) saved.push({ name: r.name, url: r.url, id: r.id });
  });

  var dup = gmailFindDuplicateRepair_(meta.shipCode, meta.system, meta.date, meta.content); // L4
  if (dup) {
    var patch = { attachments: (dup.attachments || []).concat(saved),
      sourceMsgId: dup.sourceMsgId || msgId };
    if (opts.note) patch.symptom = opts.note;
    // 기존 레코드에 Gmail 링크 없으면 보충
    if (!dup.emailLink) {
      patch.emailLink = gmailMessageUrl_(msg);
      try { patch.emailSubject = msg.getSubject() || ''; } catch (es2) {}
    }
    updateRepair(dup.id, patch);
    props.setProperty(GMDONE_PREFIX + msgId, '1');
    return { status: 'attached', line: line, toId: dup.id };
  }
  var folderId = getEventFolder_(meta.system, meta.shipCode, meta.date, meta.content);
  var atts2 = [{ name: '폴더: ' + meta.content, url: driveFolderUrl_(folderId), id: folderId }]
    .concat(saved);
  // 요약: PDF 있으면 Gemini PDF 전송, 없으면 본문 Gemini 요약
  var summary = '';
  if (opts.summarize !== false) {
    if (keep.length) {
      summary = geminiSummarizePdf_(keep[0].copyBlob(), meta);
    } else {
      // 첨부 없는 메일: 본문 텍스트를 Gemini로 요약
      var bodyForSummary = emailBodyTop_(msg);
      if (bodyForSummary.length > 30) {
        summary = geminiSummarize_(bodyForSummary, meta);
      }
    }
  }
  var emailSubject = '';
  try { emailSubject = msg.getSubject() || ''; } catch (es) {}
  var emailLink = gmailMessageUrl_(msg);
  var actionText = summary ||
    (emailSubject ? '[메일] ' + emailSubject : (hasAttachments ? 'Gmail 자동수집' : 'Gmail 자동수집(본문)'));
  addRepair({                              // L1: id='GM_'+msgId (upsert 멱등)
    id: 'GM_' + msgId, shipCode: meta.shipCode, system: meta.system, date: meta.date,
    equip: meta.content, stage: 'done', symptom: opts.note || '',
    action: actionText,
    attachments: atts2, sourceFolderId: folderId,
    sourceMsgId: thId ? (msgId + ' @thread:' + thId) : msgId,
    needsReview: (opts.summarize !== false) && !summary && !opts.note,
    emailSubject: emailSubject, emailLink: emailLink
  });
  props.setProperty(GMDONE_PREFIX + msgId, '1');
  return { status: 'added', line: line };
}

/** 수집 엔진. opts={dryRun,sources,maxThreads}. dryRun 기본 true */
function collectGmail(opts) {
  opts = opts || {};
  var dryRun = opts.dryRun !== false;
  var sources = opts.sources || [
    'techcross', 'alfalaval',             // BWTS vendors
    'union', 'hyundai_material',          // EGCS vendors
    'hps', 'panasia',                     // EGCS vendors
    'egcs_general', 'bwts_general',       // keyword fallback
    'vendor_text'                         // text-only vendor emails
  ];
  var Q = gmailQueries_(opts.window);
  var sysMap = {
    techcross: 'BWTS', alfalaval: 'BWTS', bwts_general: 'BWTS',
    union: 'EGCS', hyundai_material: 'EGCS',
    hps: 'EGCS', panasia: 'EGCS', egcs_general: 'EGCS',
    vendor_text: ''  // domain detection at message level
  };

  var seen = {}, msgs = [];
  sources.forEach(function (src) {
    if (!Q[src]) return;
    gmailSearchMessages_(Q[src], opts.maxThreads || 300).forEach(function (m) {
      var id = m.getId();
      if (seen[id]) return;
      seen[id] = src;
      msgs.push({ msg: m, src: src });
    });
  });

  var props = PropertiesService.getScriptProperties();
  var pending;
  if (opts.reprocess) {                 // 처리표시(GMDONE)됐어도 DB에 없는 것 재시도(개선 매칭 적용)
    var savedMsgC = {};
    readAll_('Repairs').forEach(function (r) {
      var s = String(r.sourceMsgId || ''); if (s) savedMsgC[s.split(' @thread:')[0]] = true;
    });
    pending = msgs.filter(function (x) { return !savedMsgC[x.msg.getId()]; });
  } else {
    pending = msgs.filter(function (x) { return !props.getProperty(GMDONE_PREFIX + x.msg.getId()); });
  }
  var batch = pending.slice(0, opts.batch || GMAIL_BATCH_MSGS);

  var report = { dryRun: dryRun, scanned: msgs.length, pending: pending.length,
    added: [], attached: [], unmatched: [], skipped: 0, errors: [],
    remaining: Math.max(0, pending.length - batch.length) };

  batch.forEach(function (x) {
    try {
      var r = gmailRegisterMessage_(x.msg, { dryRun: dryRun, defaultSystem: sysMap[x.src],
        summarize: opts.summarize, force: opts.reprocess, noOcr: opts.noOcr,
        allowTextOnly: x.src === 'vendor_text' });
      if (r.status === 'added' || r.status === 'would-add') report.added.push(r.line);
      else if (r.status === 'attached') report.attached.push(r.line);
      else if (r.status === 'unmatched') report.unmatched.push(r.subject);
      else report.skipped++;
    } catch (e) {
      // 메일 1건의 예외가 forEach(그 회차 진행분) 전체를 중단시키지 않도록 격리
      var mid = (x.msg && x.msg.getId) ? x.msg.getId() : '?';
      report.errors.push(mid + ': ' + String(e).slice(0, 120));
      // 실패 횟수 추적 — GMDONE_MAX_RETRY 초과 시 해당 메일 스킵(무한루프 방지)
      if (!dryRun && mid !== '?') {
        var failKey = GMDONE_FAIL_PREFIX + mid;
        var failCount = Number(props.getProperty(failKey) || 0) + 1;
        if (failCount >= GMDONE_MAX_RETRY) {
          props.setProperty(GMDONE_PREFIX + mid, 'FAIL');
          props.deleteProperty(failKey);
        } else {
          props.setProperty(failKey, String(failCount));
        }
      }
    }
  });

  if (!dryRun) {
    props.setProperty(LAST_SYNC_KEY, JSON.stringify({
      at: nowKst_(), added: report.added.length, attached: report.attached.length,
      unmatched: report.unmatched.length, scanned: report.scanned,
      remaining: report.remaining,
      errors: report.errors.length, errorSample: report.errors.slice(0, 3)
    }));
    appendCollectLog_({                      // 회차별 업데이트 로그 누적
      at: nowKst_(), trigger: opts.trigger,
      added: report.added, attached: report.attached,
      unmatched: report.unmatched, errors: report.errors.length
    });
    invalidateBootCache_();
    // 변경분이 있을 때만 대시보드 스냅샷을 배치당 1회 갱신(메시지마다 X)
    if (report.added.length || report.attached.length) {
      try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); }
    }
  }
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/* ── Gmail 정리 현황 리포트 (관리자) ───────────────────────────
   메시지당 DB조회 없이 1회 스캔으로 저장됨/미저장/미매칭/인보이스/DB중복을 분류.
   인보이스는 리포트 전용(추가 안 함). */
function gmailInvoiceQuery_() {
  return '(from:techcross.com OR from:alfalaval.com OR ' +
    'from:unionkr.com OR from:hyundaimaterials.com OR ' +
    'from:hhi-power.com OR from:worldpanasia.com) ' +
    'has:attachment filename:pdf ' +
    GMAIL_SCAN_WINDOW +
    ' subject:(invoice OR 인보이스 OR 송장 OR 계산서 OR 비용 OR quotation OR 견적)';
}

function reconcileGmail(opts) {
  requireRole_('admin');
  opts = opts || {};
  var maxThreads = opts.maxThreads || 250;
  var sysMap = {
    techcross: 'BWTS', alfalaval: 'BWTS', bwts_general: 'BWTS',
    union: 'EGCS', hyundai_material: 'EGCS',
    hps: 'EGCS', panasia: 'EGCS', egcs_general: 'EGCS'
  };
  var Q = gmailQueries_();

  // DB에 저장된 메시지 집합(sourceMsgId 앞 토큰) + 선박|시스템 인덱스(중복경고용)
  // readAll_ 1회로 savedMsg와 기존레코드 인덱스를 함께 구성(아이템마다 재조회 금지: O(n*m) 방지)
  var savedMsg = {};
  var repairIndex = {};   // key: shipCode + '|' + system → [{id,dateMs,date,equip}]
  readAll_('Repairs').forEach(function (r) {
    var src = String(r.sourceMsgId || '');
    if (src) savedMsg[src.split(' @thread:')[0]] = true;
    var ds = toDateStr_(r.date);
    var dms = ds ? new Date(ds + 'T00:00:00Z').getTime() : NaN;
    var key = String(r.shipCode || '') + '|' + (r.system || 'BWTS');
    (repairIndex[key] = repairIndex[key] || []).push(
      { id: r.id, dateMs: dms, date: ds, equip: String(r.equip || '') });
  });
  // 보류항목 1건당 인덱스 1회 조회(±WARN_DAYS). willAttach=true(±DUP_DAYS)면 추가 시
  // 기존 행에 병합(안전), false면 7일 초과라 새 행 생성 위험 → 경고.
  var WARN_DAYS = DUP_DAYS * 6;   // ≈42일: 7일 초과 근접건도 경고에 노출
  function findExistingMatch_(shipCode, system, date) {
    var ds = toDateStr_(date);
    var target = ds ? new Date(ds + 'T00:00:00Z').getTime() : NaN;
    if (isNaN(target)) return null;
    var bucket = repairIndex[String(shipCode || '') + '|' + (system || 'BWTS')];
    if (!bucket) return null;
    var best = null, bestDiff = 1e15;
    for (var i = 0; i < bucket.length; i++) {
      if (isNaN(bucket[i].dateMs)) continue;
      var diff = Math.abs(bucket[i].dateMs - target) / 86400000;
      if (diff <= WARN_DAYS && diff < bestDiff) { bestDiff = diff; best = bucket[i]; }
    }
    return best ? { id: best.id, date: best.date, equip: best.equip,
      diffDays: Math.round(bestDiff), willAttach: bestDiff <= DUP_DAYS } : null;
  }

  function link(id) { return 'https://mail.google.com/mail/u/0/#all/' + id; }
  function searchThreads(query) {
    var out = [], start = 0, page = 100;
    if (!query) return out;
    while (start < maxThreads) {
      var ths = GmailApp.search(query, start, Math.min(page, maxThreads - start));
      if (!ths.length) break;
      for (var i = 0; i < ths.length; i++) out.push(ths[i]);
      if (ths.length < page) break;
      start += page;
    }
    return out;
  }

  // 스레드 단위 분류 — 형제메시지(원본+Re/Fw)를 1건으로 합치고, 저장된 스레드는 제외
  var seenTh = {}, savedThreads = 0, pending = [], unmatched = [], invoice = [];
  function processThread(t, srcKey, isInvoice) {
    var tid; try { tid = t.getId(); } catch (e) { return; }
    if (seenTh[tid]) return; seenTh[tid] = true;
    var msgs; try { msgs = t.getMessages(); } catch (e) { return; }
    var saved = msgs.some(function (m) {
      try { return !!savedMsg[m.getId()]; } catch (e2) { return false; }
    });
    if (saved && !isInvoice) { savedThreads++; return; }
    var rep = null, names = {};
    msgs.forEach(function (m) {
      var as; try { as = m.getAttachments(); } catch (e) { as = []; }
      as.forEach(function (a) {
        var n = a.getName() || '';
        if (!/\.pdf$/i.test(n)) return;
        names[n] = true;
        if (!isInvoice && !rep && gmailClassifyAttachment_(a).keep) rep = m;
      });
    });
    if (!rep) rep = msgs[msgs.length - 1];
    var meta = gmailParseMessageMeta_(rep, isInvoice ? 'BWTS' : sysMap[srcKey]);
    var mid = ''; try { mid = rep.getId(); } catch (e) {}
    var subj = ''; try { subj = rep.getSubject() || ''; } catch (e) {}
    var entry = { msgId: mid, link: link(mid), shipCode: meta.shipCode, system: meta.system,
      date: meta.date, subject: subj, atts: Object.keys(names), msgN: msgs.length };
    if (isInvoice) invoice.push(entry);
    else if (meta.shipCode) {
      // 기존 DB에 선박+시스템+근접일자 레코드가 있으면 경고 플래그(추가 전 확인용)
      entry.existingMatch = findExistingMatch_(meta.shipCode, meta.system, meta.date);
      pending.push(entry);
    }
    else unmatched.push(entry);
  }

  Object.keys(Q).forEach(function (s) {
    searchThreads(Q[s]).forEach(function (t) { processThread(t, s, false); });
  });
  searchThreads(gmailInvoiceQuery_()).forEach(function (t) { processThread(t, 'invoice', true); });

  // 미저장을 선박별로 그룹(많을 때 보기 쉽게)
  var byShip = {};
  pending.forEach(function (e) { (byShip[e.shipCode] = byShip[e.shipCode] || []).push(e); });
  var pendingGroups = Object.keys(byShip).sort().map(function (code) {
    return { shipCode: code, items: byShip[code] };
  });

  var dups = gmailDuplicateGroups_().map(function (gr) {
    return { shipCode: gr.keep.shipCode, system: gr.keep.system, equip: gr.keep.equip,
      date: toDateStr_(gr.keep.date), dropN: gr.drop.length };
  });

  return JSON.stringify({ scannedThreads: Object.keys(seenTh).length,
    savedThreads: savedThreads, pendingCount: pending.length, pendingGroups: pendingGroups,
    unmatched: unmatched, invoice: invoice, dups: dups });
}

/** 리포트에서 선택한 메시지들을 실제 수집(승인 게이트). 갱신 STATE 반환. */
function addSelectedGmail(items) {
  requireRole_('admin');
  items = items || [];
  var added = 0, failed = 0;
  items.forEach(function (it) {
    var id = (typeof it === 'string') ? it : (it && it.msgId);
    var forceShip = (typeof it === 'object' && it) ? (it.shipCode || '') : '';
    if (!id) { failed++; return; }
    try {
      var m = GmailApp.getMessageById(id);
      var from = ''; try { from = m.getFrom() || ''; } catch (e) {}
      var sys = detectSystemByDomain_(from);
      var r = gmailRegisterMessage_(m, { dryRun: false, defaultSystem: sys, shipCode: forceShip });
      if (r.status === 'added' || r.status === 'attached') added++; else failed++;
    } catch (e) { failed++; }
  });
  return JSON.stringify({ added: added, failed: failed, bootstrap: getBootstrap() });
}

/** Gmail 전수 → 'Gmail검토' 시트로 정리(관리자). 한 스레드=1행, 본문요지·첨부·저장여부 포함.
    저장은 안 함(검토 전용). 반환 {count, url}. */
function buildGmailReviewSheet(opts) {
  requireRole_('admin');
  opts = opts || {};
  var capMaker = opts.capMaker || 300, capWide = opts.capWide || 150;
  var sysMap = {
    techcross: 'BWTS', alfalaval: 'BWTS', bwts_general: 'BWTS',
    union: 'EGCS', hyundai_material: 'EGCS',
    hps: 'EGCS', panasia: 'EGCS', egcs_general: 'EGCS',
    vendor_text: '', invoice: ''
  };
  var Q = gmailQueries_();
  var savedMsg = {};
  readAll_('Repairs').forEach(function (r) {
    var src = String(r.sourceMsgId || '');
    if (src) savedMsg[src.split(' @thread:')[0]] = true;
  });
  function link(id) { return 'https://mail.google.com/mail/u/0/#all/' + id; }
  function searchThreads(query, cap) {
    var out = [], start = 0, page = 100;
    if (!query) return out;
    while (start < cap) {
      var ths = GmailApp.search(query, start, Math.min(page, cap - start));
      if (!ths.length) break;
      for (var i = 0; i < ths.length; i++) out.push(ths[i]);
      if (ths.length < page) break;
      start += page;
    }
    return out;
  }
  // 기존 시트의 사용자 입력 보존(msgId 기준): 저장?·메모·상태(등록완료)·선박
  var ss = getSS_();
  var prev = {};
  var existing = ss.getSheetByName('Gmail검토');
  if (existing && existing.getLastRow() > 1) {
    existing.getRange(2, 1, existing.getLastRow() - 1, 14).getValues().forEach(function (r) {
      var mid = String(r[13] || ''); if (!mid) return;
      prev[mid] = { save: r[0] === true || /^(y|o|1|true|저장)$/i.test(String(r[0])),
        memo: r[1] || '', status: r[2] || '', ship: r[3] || '' };
    });
  }

  var seenTh = {}, items = [];
  function process(t, srcKey) {
    var tid; try { tid = t.getId(); } catch (e) { return; }
    if (seenTh[tid]) return; seenTh[tid] = true;
    var msgs; try { msgs = t.getMessages(); } catch (e) { return; }
    if (!msgs.length) return;
    var isInv = srcKey === 'invoice';
    var saved = msgs.some(function (m) {
      try { return !!savedMsg[m.getId()]; } catch (e2) { return false; }
    });
    var rep = msgs[0], names = {};                       // 원본(스레드 첫 메시지)
    try {
      rep.getAttachments().forEach(function (a) {
        var n = a.getName() || ''; if (/\.pdf$/i.test(n)) names[n] = 1;
      });
    } catch (e) {}
    var meta = gmailParseMessageMeta_(rep, sysMap[srcKey] || undefined);
    var mid = ''; try { mid = rep.getId(); } catch (e) {}
    var subj = ''; try { subj = rep.getSubject() || ''; } catch (e) {}
    var from = ''; try { from = rep.getFrom() || ''; } catch (e) {}
    var body = emailBodyTop_(rep).replace(/\s+/g, ' ').slice(0, 250);
    var p = prev[mid];
    var status = isInv ? '인보이스'
      : ((p && p.status === '등록완료') ? '등록완료' : (saved ? '이미저장' : '미저장'));
    items.push({ mid: mid, save: p ? p.save : false, memo: p ? p.memo : '', status: status,
      ship: p ? p.ship : (meta.shipCode || ''), system: meta.system || '', date: meta.date || '',
      subj: subj, body: body, atts: Object.keys(names), from: from, src: srcKey });
  }
  searchThreads(Q.techcross, capMaker).forEach(function (t) { process(t, 'techcross'); });
  searchThreads(Q.alfalaval, capMaker).forEach(function (t) { process(t, 'alfalaval'); });
  searchThreads(Q.egcs, capWide).forEach(function (t) { process(t, 'egcs'); });
  searchThreads(gmailInvoiceQuery_(), capWide).forEach(function (t) { process(t, 'invoice'); });

  // 중복첨부: 같은 PDF 파일명이 서로 다른 스레드에 등장 → 표시(중복 판별 도움)
  var nameMap = {};
  items.forEach(function (it, idx) {
    it.atts.forEach(function (n) {
      var key = String(n).toLowerCase().trim();
      (nameMap[key] = nameMap[key] || []).push(idx);
    });
  });
  items.forEach(function (it) {
    var others = {};
    it.atts.forEach(function (n) {
      (nameMap[String(n).toLowerCase().trim()] || []).forEach(function (j) {
        if (items[j].mid !== it.mid) others[items[j].mid] = 1;
      });
    });
    var c = Object.keys(others).length;
    it.dup = c ? ('⚠ 동일첨부 ' + c + '건') : '';
  });

  items.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }); // 최신일자순
  var rows = items.map(function (it) {
    return [ it.save === true, it.memo, it.status, it.ship, it.system, it.date, it.subj,
      it.body, it.atts.join('\n'), it.dup, it.from, link(it.mid), it.src, it.mid ];
  });

  var old = ss.getSheetByName('Gmail검토'); if (old) ss.deleteSheet(old);
  var sh = ss.insertSheet('Gmail검토');
  var header = ['저장?', '메모', '상태', '선박', '시스템', '일자', '제목', '본문요지',
                '첨부PDF', '중복첨부', '발신', 'Gmail링크', '소스', 'msgId'];
  sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  if (rows.length) {
    sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.getRange(2, 1, rows.length, 1).insertCheckboxes();   // 저장? = 체크박스
  }
  sh.setFrozenRows(1);
  [50, 220, 80, 80, 64, 92, 300, 340, 180, 110, 160, 88, 80, 150]
    .forEach(function (w, i) { sh.setColumnWidth(i + 1, w); });
  return JSON.stringify({ count: rows.length, url: ss.getUrl() + '#gid=' + sh.getSheetId() });
}

/** 'Gmail검토' 시트에서 저장?=체크된 행을 DB에 등록(관리자). 선박·메모는 시트값 사용.
    등록된 행은 상태=등록완료로 갱신. 1회 40건 상한. */
function importReviewSheet() {
  requireRole_('admin');
  var ss = getSS_();
  var sh = ss.getSheetByName('Gmail검토');
  if (!sh || sh.getLastRow() < 2) return JSON.stringify({ registered: 0, failed: 0, msg: '시트 없음' });
  var data = sh.getRange(2, 1, sh.getLastRow() - 1, 14).getValues();
  var registered = 0, failed = 0;
  for (var i = 0; i < data.length; i++) {
    var r = data[i];
    var save = r[0] === true || /^(y|o|1|true|저장)$/i.test(String(r[0]));
    var status = String(r[2] || ''), src = String(r[12] || ''), mid = String(r[13] || '');
    if (!save || status === '등록완료' || src === 'invoice' || !mid) continue;
    if (registered + failed >= 40) break;
    var ship = String(r[3] || '').trim(), memo = String(r[1] || '');
    if (!ship) { failed++; sh.getRange(i + 2, 3).setValue('선박 필요'); continue; }
    try {
      var m = GmailApp.getMessageById(mid);
      var from = ''; try { from = m.getFrom() || ''; } catch (e) {}
      var sys = detectSystemByDomain_(from);
      var res = gmailRegisterMessage_(m,
        { dryRun: false, defaultSystem: sys, shipCode: ship, note: memo });
      if (res.status === 'added' || res.status === 'attached') {
        registered++; sh.getRange(i + 2, 3).setValue('등록완료'); sh.getRange(i + 2, 1).setValue(false);
      } else { failed++; sh.getRange(i + 2, 3).setValue('실패:' + res.status); }
    } catch (e2) { failed++; sh.getRange(i + 2, 3).setValue('오류'); }
  }
  return JSON.stringify({ registered: registered, failed: failed, bootstrap: getBootstrap() });
}

/** GM_* cert 레코드 등록날짜를 PDF OCR 날짜와 대조(소배치) */
function gmailVerifyCertDate_(fileId, registeredDate) {
  var text = '';
  try { text = ocrPdfText_(DriveApp.getFileById(fileId).getBlob()); }
  catch (e) { return { ocrDate: '', match: null, error: String(e) }; }
  var m = text.match(
    /(Date of Calibration|Calibration Date|발행일|검교정일|Issued)\s*[:\-]?\s*(\d{4}\D\d{1,2}\D\d{1,2})/i);
  var ocrDate = m ? toDateStr_(m[2]) : '';
  var match = ocrDate ? (ocrDate === toDateStr_(registeredDate)) : null;
  return { ocrDate: ocrDate, match: match };
}

/* ── 과거 메일 일괄정리 — 앱 버튼: 미리보기 → 실행 ───────────────
   전체소스(테크로스·알파라발·EGCS). 고속모드(OCR·AI요약 생략)로 빠르게.
   선박 못 찾는 노이즈는 미매칭으로 자동 스킵. 중복은 L1~L4로 자동 차단.
   재처리(reprocess): 처리완료 표시됐어도 DB에 없는 건 개선된 매칭으로 재시도. */
var IMPORT_SOURCES = [
  'techcross', 'alfalaval',
  'union', 'hyundai_material', 'hps', 'panasia',
  'egcs_general', 'bwts_general', 'vendor_text'
];
function previewImport() {
  requireRole_('admin');
  return JSON.stringify(collectGmail({
    sources: IMPORT_SOURCES, dryRun: true, batch: 250, reprocess: true, noOcr: true }));
}
function runImport() {
  requireRole_('admin');
  var rep = collectGmail({ sources: IMPORT_SOURCES, dryRun: false, batch: 150,
    reprocess: true, noOcr: true, summarize: false });
  rep.bootstrap = getBootstrap();
  return JSON.stringify(rep);
}

/* ── 분석: 선박별 정비빈도·이력 + 자주 등장 장비/이슈 ─────────────── */
function getAnalytics() {
  requireRole_('viewer');
  var reps = readAll_('Repairs').map(parseRepair_);
  var ships = {};
  readAll_('Ships').forEach(function (s) { ships[s.code] = s.name || ''; });
  // 선박별 집계
  var byShip = {};
  reps.forEach(function (r) {
    var c = r.shipCode || '(미상)';
    var g = byShip[c] || (byShip[c] = { code: c, name: ships[c] || '', count: 0,
      last: '', sys: {} });
    g.count++;
    if (r.system) g.sys[r.system] = 1;
    var d = toDateStr_(r.date);
    if (d && d > g.last) g.last = d;
  });
  var shipRows = Object.keys(byShip).map(function (c) {
    var g = byShip[c]; g.systems = Object.keys(g.sys).join('·'); delete g.sys; return g;
  }).sort(function (a, b) { return b.count - a.count; });

  // 자주 등장하는 장비/이슈 — 정비기록 텍스트에서 키워드 빈도
  var KW = ['Sensor Calibration', 'Calibration', '검교정', 'FMU', 'CSU', 'GDS', 'FTS',
    'TRO', 'PRU', 'TSU', 'CLX', 'Flow Meter', 'Optic', 'ORP', 'PH', 'P/S', 'GFS',
    'WMS', 'TURB', 'PAH', 'CEMS', '다공판', 'Scrubber', '스크러버', 'Pump', 'USCG',
    'Local PC', 'Communication', 'BODY CRACK', 'GPS'];
  var cnt = {};
  reps.forEach(function (r) {
    var t = [(r.equip || ''), (r.symptom || ''), (r.action || '')].join(' ');
    KW.forEach(function (k) {
      if (new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(t))
        cnt[k] = (cnt[k] || 0) + 1;
    });
  });
  var comp = Object.keys(cnt).map(function (k) { return { term: k, count: cnt[k] }; })
    .filter(function (x) { return x.count > 0; })
    .sort(function (a, b) { return b.count - a.count; });

  return JSON.stringify({ total: reps.length, byShip: shipRows, components: comp });
}

/* ── BWTS 검교정 cert 찾기 — 검교정일 ±N개월로 메일 검색 → cert 가져오기 ───
   cert 없는 BWTS 검교정만 대상. dryRun=true면 후보만, false면 등록. */
function certWindow_(dateStr, months) {
  var d = new Date(dateStr + 'T00:00:00Z');
  var a = new Date(d.getTime()); a.setUTCMonth(a.getUTCMonth() - months);
  var b = new Date(d.getTime()); b.setUTCMonth(b.getUTCMonth() + months);
  function f(x) { return Utilities.formatDate(x, 'UTC', 'yyyy/MM/dd'); }
  return 'after:' + f(a) + ' before:' + f(b);
}
function findBwtsCerts(dryRun, months) {
  requireRole_('admin');
  months = months || 4;
  var cals = readAll_('Calibrations').filter(function (c) {
    return (c.system || 'BWTS') === 'BWTS' && toDateStr_(c.lastCalibration);
  });
  var reps = readAll_('Repairs').map(parseRepair_);
  function isCertAtt(a) {
    var n = a.name || '';
    return /pdf$/i.test(n) && (/\btech[-\s]?\d{3,}/i.test(n) || /cert|csp|uscg|성적서|검교정/i.test(n));
  }
  var DAY = 86400000;
  function hasCertNear(code, dStr) {                       // 검교정일 ±months 안에 cert 있나
    var t = new Date(dStr + 'T00:00:00Z').getTime();
    if (isNaN(t)) return false;
    return reps.some(function (r) {
      if (r.shipCode !== code || (r.system || 'BWTS') !== 'BWTS') return false;
      if (!(r.attachments || []).some(isCertAtt)) return false;
      var rt = new Date(toDateStr_(r.date) + 'T00:00:00Z').getTime();
      return !isNaN(rt) && Math.abs(rt - t) <= months * 31 * DAY;
    });
  }
  var out = [];
  cals.forEach(function (c) {
    var d = toDateStr_(c.lastCalibration);
    if (hasCertNear(c.shipCode, d)) return;                // 최근 검교정에 cert 이미 있음
    var name = (SHIP_SEED[c.shipCode] && SHIP_SEED[c.shipCode].name) || c.shipCode;
    var q = '(from:techcross.com OR from:alfalaval.com OR ' +
      'from:unionkr.com OR from:hyundaimaterials.com OR ' +
      'from:hhi-power.com OR from:worldpanasia.com) ' +
      'has:attachment filename:pdf ' +
      certWindow_(d, months) +
      ' subject:(Calibration OR Cert OR Certificate OR USCG OR CSP OR "Service report") "' + name + '"';
    var ths = GmailApp.search(q, 0, 10);
    var hit = null, certName = '';
    for (var i = 0; i < ths.length && !hit; i++) {
      var msgs = ths[i].getMessages();
      for (var j = 0; j < msgs.length && !hit; j++) {
        var as; try { as = msgs[j].getAttachments(); } catch (e) { as = []; }
        for (var k = 0; k < as.length; k++) {
          var nm = as[k].getName() || '';
          if (/\.pdf$/i.test(nm) &&
              (gmailClassifyAttachment_(as[k]).kind === 'cert' ||
               /cert|calibration|csp|tech[-\s]?\d{3,}|uscg/i.test(nm))) {
            hit = msgs[j]; certName = nm; break;
          }
        }
      }
    }
    if (!hit) { out.push({ shipCode: c.shipCode, calDate: d, found: false }); return; }
    var mid = hit.getId();
    var rec = { shipCode: c.shipCode, calDate: d, found: true, msgId: mid,
      subject: hit.getSubject() || '', cert: certName,
      link: 'https://mail.google.com/mail/u/0/#all/' + mid };
    if (!dryRun) {
      var res = gmailRegisterMessage_(hit,
        { dryRun: false, shipCode: c.shipCode, noOcr: true, summarize: false });
      rec.status = res.status;
    }
    out.push(rec);
  });
  var result = { items: out,
    found: out.filter(function (x) { return x.found; }).length,
    missing: out.filter(function (x) { return !x.found; }).length };
  if (!dryRun) result.bootstrap = getBootstrap();
  return JSON.stringify(result);
}

/* ── Gmail 수집 실행 래퍼 (에디터 클릭 실행) ──────────────────
   순서: run_collectGmail_DRY → 검토 → run_collectGmail_REAL (remaining=0까지 반복) */
function run_collectGmail_DRY()    { return collectGmail({ dryRun: true }); }
function run_collectGmail_REAL()   { return collectGmail({ dryRun: false }); }
function run_collectTechcross_DRY(){ return collectGmail({ dryRun: true,  sources: ['techcross'] }); }
function run_collectTechcross_REAL(){ return collectGmail({ dryRun: false, sources: ['techcross'] }); }
function run_collectAlfaLaval_DRY(){ return collectGmail({ dryRun: true,  sources: ['alfalaval'] }); }
function run_collectAlfaLaval_REAL(){ return collectGmail({ dryRun: false, sources: ['alfalaval'] }); }
function run_collectEGCS_DRY()     { return collectGmail({ dryRun: true,  sources: ['union','hyundai_material','hps','panasia','egcs_general'], batch: 15 }); }
function run_collectEGCS_REAL()    { return collectGmail({ dryRun: false, sources: ['union','hyundai_material','hps','panasia','egcs_general'], batch: 15 }); }

/* ── 버스트 수집 (임시 트리거: 1분 간격, 잔여 0이면 자동 종료) ──
   installBurstCollect() 1회 실행 → 매분 자동 처리 → 완료 시 트리거 자동 삭제.
   중간에 멈추려면 removeBurstCollect() 실행. */
function installBurstCollect() {
  removeBurstCollect();  // 기존 트리거 정리
  ScriptApp.newTrigger('burstCollectGmail_')
    .timeBased().everyMinutes(1).create();
  Logger.log('burst trigger installed — runs every 1 min');
  return 'burst trigger ON';
}
function removeBurstCollect() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'burstCollectGmail_')
      ScriptApp.deleteTrigger(t);
  });
  Logger.log('burst trigger removed');
  return 'burst trigger OFF';
}
function burstCollectGmail_() {
  var t0 = Date.now();
  var rep = collectGmail({ dryRun: false, window: 'newer_than:3y',
    batch: 15, summarize: true, trigger: 'burst' });
  // 잔여 0이면 트리거 자동 삭제
  if (rep.remaining <= 0 && rep.added.length === 0) {
    removeBurstCollect();
    Logger.log('burst complete — trigger auto-removed');
  }
  Logger.log('burst: +' + rep.added.length +
    ' attached:' + rep.attached.length +
    ' remaining:' + rep.remaining);
}

/** Gmail 수집(GM_*) 레코드 현황 진단 (실시간) */
function run_gmailStatus() {
  var rows = readAll_('Repairs');
  var gm = rows.filter(function (r) { return String(r.id).indexOf('GM_') === 0; });
  var byShip = {};
  gm.forEach(function (r) { byShip[r.shipCode] = (byShip[r.shipCode] || 0) + 1; });
  var rep = {
    gmCount: gm.length, totalRepairs: rows.length, byShip: byShip,
    samples: gm.slice(0, 10).map(function (r) {
      var att = 0; try { att = JSON.parse(r.attachments || '[]').length; } catch (e) {}
      return r.shipCode + ' | ' + r.date + ' | ' + r.equip + ' (첨부' + att + ')';
    })
  };
  Logger.log(JSON.stringify(rep, null, 2));
  return rep;
}

/** Gmail 수집(GM_*) 레코드 전체 삭제 — 깨끗한 재수집용(MIG_·일반은 보존) */
function run_purgeGmail() {
  var sh = sheet_('Repairs');
  var last = sh.getLastRow();
  if (last < 2) return 'no rows';
  var ids = sh.getRange(2, 1, last - 1, 1).getValues(), n = 0;
  for (var i = ids.length - 1; i >= 0; i--) {
    if (String(ids[i][0]).indexOf('GM_') === 0) { sh.deleteRow(i + 2); n++; }
  }
  return 'purged ' + n + ' GM_ rows';
}

/** 기존 GM_ 레코드(요약 없는 것)에 Gemini 요약 소급 채우기. 1회 8건(시간제한).
   remaining>0이면 반복 실행. Gemini 키 미설정 시 아무것도 안 함. */
function run_summarizeExisting_REAL() {
  if (!PropertiesService.getScriptProperties().getProperty(GEMINI_KEY_PROP)) {
    return { error: 'GEMINI_API_KEY 미설정' };
  }
  var rows = readAll_('Repairs'), n = 0, LIMIT = 8, out = [], remaining = 0;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.id).indexOf('GM_') !== 0) continue;
    if (r.action && r.action !== 'Gmail 자동수집') continue; // 이미 요약 있음
    if (n >= LIMIT) { remaining++; continue; }
    var atts = [];
    try { atts = r.attachments ? JSON.parse(r.attachments) : []; } catch (e) {}
    var pdf = atts.filter(function (a) { return /pdf$/i.test(a.name || '') && a.id; })[0];
    if (!pdf) continue;
    var blob = driveGetBlob_(pdf.id);
    if (!blob) continue;
    var summary = geminiSummarizePdf_(blob, { shipCode: r.shipCode, system: r.system });
    if (summary) { updateRepair(r.id, { action: summary }); out.push(r.shipCode + ' ' + r.date); n++; }
  }
  if (n > 0) { try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); } }
  var rep = { summarized: out, count: n, remaining: remaining };
  Logger.log(JSON.stringify(rep, null, 2));
  return rep;
}

/** 요약 소급이 왜 0건인지 단계별 진단 (GM_ 3건). */
function run_summarizeDebug() {
  var rows = readAll_('Repairs'), out = [], n = 0;
  for (var i = 0; i < rows.length && n < 3; i++) {
    var r = rows[i];
    if (String(r.id).indexOf('GM_') !== 0) continue;
    var rec = { id: r.id, shipCode: r.shipCode,
      action: String(r.action || '').substring(0, 30),
      needs: (!r.action || r.action === 'Gmail 자동수집') };
    var atts = [];
    try { atts = r.attachments ? JSON.parse(r.attachments) : []; } catch (e) {}
    rec.attNames = atts.map(function (a) { return (a.name || '').substring(0, 24); });
    var pdf = atts.filter(function (a) { return /pdf$/i.test(a.name || '') && a.id; })[0];
    rec.pdfFound = !!pdf;
    if (pdf) {
      var err = '';
      try {
        var blob = driveGetBlob_(pdf.id);
        rec.blobBytes = blob ? blob.getBytes().length : 0;
        if (blob) rec.summaryLen = (geminiSummarizePdf_(blob,
          { shipCode: r.shipCode, system: r.system }) || '').length;
      } catch (e2) { err = String(e2); }
      rec.err = err;
    }
    out.push(rec); n++;
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/** 처리완료 표시 초기화(전체 재스캔 시) */
function run_collectGmail_RESET() {
  var props = PropertiesService.getScriptProperties(), all = props.getProperties(), n = 0;
  Object.keys(all).forEach(function (key) {
    if (key.indexOf(GMDONE_PREFIX) === 0 || key === GMAIL_CURSOR_KEY) {
      props.deleteProperty(key); n++;
    }
  });
  return 'reset ' + n + ' keys';
}

/** GM_* cert 레코드 OCR 날짜 검증(1회 10건). 불일치는 action에 표기 */
function run_verifyCertDates_REAL() {
  var rows = readAll_('Repairs'), out = [], checked = 0, LIMIT = 10;
  for (var i = 0; i < rows.length && checked < LIMIT; i++) {
    var r = rows[i];
    if (String(r.id).indexOf('GM_') !== 0) continue;
    if (/\[OCR/.test(r.action || '')) continue; // 이미 검증
    var atts = [];
    try { atts = r.attachments ? JSON.parse(r.attachments) : []; } catch (e) {}
    var cert = atts.filter(function (a) {
      return /pdf$/i.test(a.name || '') &&
        (/\btech[-\s]?\d{3,}/i.test(a.name) || /cert/i.test(a.name));
    })[0];
    if (!cert || !cert.id) continue;
    checked++;
    var v = gmailVerifyCertDate_(cert.id, r.date);
    if (v.ocrDate && v.match === false) {
      updateRepair(r.id, { action: (r.action || '') + ' [OCR일자 ' + v.ocrDate + ' 불일치]' });
      out.push(r.shipCode + ' 등록 ' + r.date + ' vs OCR ' + v.ocrDate);
    }
  }
  if (out.length) { try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); } }
  var rep = { checked: checked, mismatches: out };
  Logger.log(JSON.stringify(rep, null, 2));
  return rep;
}

/* ── 시드 / 마스터 동기화 ──────────────────────────────────── */
var SEED_DONE_KEY = 'SEED_DONE';
function ensureSeed_() {
  var props = PropertiesService.getScriptProperties();
  // 시드 완료 플래그가 있으면 무거운 readAll_ 전부 건너뜀
  if (props.getProperty(SEED_DONE_KEY) === 'v2') return;
  ensureRolesSeed_();   // 권한표 비었으면 배포자=admin 시드(잠금 방지)
  ensureRolesGuide_();  // Roles 탭 E열에 사용법 안내(1회)
  var ships = readAll_('Ships');
  if (ships.length === 0) syncMasters_();
  ensureBwtsCalSeed_(); // BWTS 연간검교정 초기값 (없을 때만)
  ensureEgcsCalSeed_(); // EGCS 검교정 1회 이관 (공유시트 → 앱 DB)
  props.setProperty(SEED_DONE_KEY, 'v2');
}

/** EGCS 검교정을 공유시트에서 앱 DB로 1회 이관(버전 가드). 이후 앱에서 수정·보존. */
var EGCS_CAL_VER = 'v1';
function ensureEgcsCalSeed_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('EGCS_CAL_VER') === EGCS_CAL_VER) return;
  var egcs = readSharedEgcs_();
  if (!egcs.length) return; // 공유시트 못 읽으면 다음 기회에 (버전 안 올림)
  var sh = sheet_('Calibrations');
  var keep = readAll_('Calibrations').filter(function (c) { return c.system !== 'EGCS'; });
  var now = new Date().toISOString();
  var egcsObjs = egcs.map(function (d) {
    return { id: d.shipCode + '_' + d.equip, shipCode: d.shipCode, equip: d.equip,
      lastCalibration: d.date || '', intervalMonths: '', note: d.text || '',
      updatedAt: now, system: 'EGCS' };
  });
  var rows = keep.concat(egcsObjs).map(function (o) { return objToRow_('Calibrations', o); });
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, SHEETS.Calibrations.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, SHEETS.Calibrations.length).setValues(rows);
  props.setProperty('EGCS_CAL_VER', EGCS_CAL_VER);
}

/** BWTS 연간 검교정 초기 시드 — 없는 선박만 채움(앱에서 수정한 값 보존) */
function ensureBwtsCalSeed_() {
  var existing = {};
  readAll_('Calibrations').forEach(function (c) { existing[c.id] = true; });
  var now = new Date().toISOString();
  Object.keys(BWTS_CAL_SEED).forEach(function (code) {
    var id = code + '_BWTSCAL';
    if (existing[id]) return;
    upsert_('Calibrations', 'id', {
      id: id, shipCode: code, equip: '연간검교정',
      lastCalibration: BWTS_CAL_SEED[code] || '',
      intervalMonths: 12, note: '', updatedAt: now, system: 'BWTS',
    });
  });
}

/** 선박 마스터를 시트에 적재(merge). 버튼으로 수동 호출 가능(관리자만). */
function syncMasters() {
  requireRole_('admin');
  return syncMasters_();
}
/** 실제 적재 로직 — 내부(ensureSeed_)에서도 호출하므로 게이트 없음. */
function syncMasters_() {
  var now = new Date().toISOString();
  Object.keys(SHIP_SEED).forEach(function (code) {
    var s = SHIP_SEED[code];
    var egcs = s.egcs || {};
    upsert_('Ships', 'code', {
      code: code,
      name: s.name || '',
      teu: s.teu == null ? '' : s.teu,
      bwts_maker: s.bwts ? s.bwts.maker : '',
      egcs_maker: egcs.maker || '',
      wms: egcs.wms || '',
      cems: egcs.cems || '',
      scrubber_folder: s.scrubber_folder || '',
      updatedAt: now,
    });
  });
  ensureBwtsCalSeed_();
  return getBootstrap();   // 갱신된 전체 STATE를 직접 반환 → 클라이언트 2차 왕복 제거
}

/* BWTS 연간 검교정 마지막 일자 (대시보드 C3:C23 기준 초기값) */
var BWTS_CAL_SEED = {
  KPS: '2025-09-06', KUS: '2025-07-29', KKL: '2025-09-08', KSG: '2025-09-27',
  KJT: '2025-08-26', KSH: '2025-10-10', KQD: '2025-08-24', KTJ: '2025-03-08',
  KHM: '2026-05-08', KNB: '2026-02-12', KSZ: '2026-04-28', KCN: '2025-06-21',
  KMN: '2025-10-25', KJA: '2026-05-01', KNH: '2025-10-26', KMU: '2026-03-25',
  KCB: '2025-10-14', KSL: '2026-02-03', KDE: '', KMB: '2026-03-22', KDB: '2026-04-23'
};

/* ── 시드 데이터 (기존 React 앱에서 이전) ──────────────────── */
var SHIP_SEED = {
  "KPS": { "name": "KMTC PUSAN", "teu": "1800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KUS": { "name": "KMTC ULSAN", "teu": "1800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KKL": { "name": "KMTC KEELUNG", "teu": "1800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KSG": { "name": "KMTC SINGAPORE", "teu": "1800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KJT": { "name": "KMTC JAKARTA", "teu": "1800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KSH": { "name": "KMTC SHANGHAI", "teu": "1800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KQD": { "name": "KMTC QINGDAO", "teu": "2800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KTJ": { "name": "KMTC TIANJIN", "teu": "2800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KHM": { "name": "KMTC HOCHIMINH", "teu": "2800 teu", "bwts": { "maker": "테크로스" }, "egcs": null },
  "KNB": { "name": "KMTC NINGBO", "teu": "2800 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "파나시아" }, "scrubber_folder": "01 KNB" },
  "KSZ": { "name": "KMTC SHENZHEN", "teu": "2800 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "파나시아" }, "scrubber_folder": "02 KSZ" },
  "KMB": { "name": "KMTC MUMBAI", "teu": "5500 teu", "bwts": { "maker": "알파라발" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "파나시아" }, "scrubber_folder": "03 KMB" },
  "KCN": { "name": "KMTC CHENNAI", "teu": "4300 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "파나시아" }, "scrubber_folder": "05 KCN" },
  "KMN": { "name": "KMTC MANILA", "teu": "4300 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "파나시아" }, "scrubber_folder": "08 KMN" },
  "KJA": { "name": "KMTC JEBELALI", "teu": "4300 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "파나시아" }, "scrubber_folder": "06 KJA" },
  "KNH": { "name": "KMTC NHAVASHEVA", "teu": "4300 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "파나시아" }, "scrubber_folder": "07 KNH" },
  "KMU": { "name": "KMTC MUNDRA", "teu": "6500 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "파나시아" }, "scrubber_folder": "09 KMU" },
  "KCB": { "name": "KMTC COLOMBO", "teu": "6500 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "HM", "wms": "TRI-OS", "cems": "유니온(GI)" }, "scrubber_folder": "10 KCB" },
  "KDB": { "name": "KMTC DUBAI", "teu": "5500 teu", "bwts": { "maker": "알파라발" }, "egcs": { "maker": "HPS", "wms": "GI", "cems": "ABB" }, "scrubber_folder": "04 KDB" },
  "KSL": { "name": "KMTC SEOUL", "teu": "2500 teu", "bwts": { "maker": "알파라발" }, "egcs": { "maker": "HPS", "wms": "GI", "cems": "ABB" }, "scrubber_folder": "11 KSL" },
  "KDE": { "name": "KMTC DELHI", "teu": "6500 teu", "bwts": { "maker": "테크로스" }, "egcs": { "maker": "글로벌에코", "wms": "GI", "cems": "SICK" }, "scrubber_folder": "11 KDE" }
};

/* ── 1회성 DB 정리: 오분류·equip 잡음 수정 ────────────────────────
   run_cleanupDRY() → 로그 확인 → run_cleanupREAL() */

function cleanupMisclassified_(dryRun) {
  var reps = readAll_('Repairs');
  var deleted = [], fixed = [], skipped = 0;

  reps.forEach(function (r) {
    var eq = String(r.equip || '');
    var action = String(r.action || '');
    var symptom = String(r.symptom || '');
    var all = eq + ' ' + action + ' ' + symptom;

    // 1) 견적/발주/문의 건 삭제 — 수리이력이 아님
    if (/(견적\s*건|견적서|INQUIRY|발주서|ORDER\s*SHEET)/.test(all) &&
        !/(교체|수리|점검|완료|조치)/.test(action)) {
      if (!dryRun) deleteRepair(r.id);
      deleted.push(r.id + ' | ' + r.shipCode + ' | ' + eq.substring(0, 40));
      return;
    }

    // 2) equip이 "YYYY-MM-DD CODE" 패턴 → Drive 폴더명에서 온 것. 정리
    var dateEquip = eq.match(/^(\d{4}-\d{2}-\d{2})\s*(K[A-Z]{2})?\s*(.*)$/);
    if (dateEquip) {
      var cleaned = dateEquip[3] ? sanitizeName_(dateEquip[3]) : '';
      if (!cleaned) cleaned = r.system || 'EGCS';  // 내용 없으면 시스템명 대입
      if (!dryRun) updateRepair(r.id, { equip: cleaned });
      fixed.push(r.id + ' | "' + eq + '" → "' + cleaned + '"');
      return;
    }

    // 3) equip에 메일 잡음 (방선 일정, 송부 건 등) → cleanSubject_ 재적용
    if (/(방선\s*일정|송부\s*건|전달\s*건|진행\s*관련)/.test(eq)) {
      var clean = cleanSubject_(eq);
      if (clean !== eq) {
        if (!dryRun) updateRepair(r.id, { equip: clean });
        fixed.push(r.id + ' | "' + eq.substring(0, 35) + '" → "' + clean + '"');
        return;
      }
    }

    skipped++;
  });

  var report = { dryRun: dryRun, total: reps.length,
    deleted: deleted, deletedN: deleted.length,
    fixed: fixed, fixedN: fixed.length, skipped: skipped };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

function run_cleanupDRY()  { return cleanupMisclassified_(true); }
function run_cleanupREAL() {
  var rep = cleanupMisclassified_(false);
  try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); }
  return rep;
}

/* ══════════════════════════════════════════════════════════════
   Gmail 일괄 읽기 + Gemini 구조화 → DB 임포트
   85개 threadId의 메일 본문을 읽어 Gemini로 수리이력 구조화 후 저장.
   run_enrichImportDRY() → 검토 → run_enrichImportREAL()
   ══════════════════════════════════════════════════════════════ */

/** 임포트 대상 스레드 목록 (Claude가 Gmail 검색으로 추출) */
var IMPORT_THREADS = [
  {t:'199dff12af4e5c9c',s:'KCB',y:'BWTS'},{t:'199e6e942da6b25c',s:'KCB',y:'EGCS'},
  {t:'19ad8e2e010b5f2a',s:'KCB',y:'EGCS'},{t:'19b95f029fc05bab',s:'KCB',y:'BWTS'},
  {t:'19dad804b94dac38',s:'KCB',y:'EGCS'},{t:'197be5522a0a0373',s:'KCN',y:'EGCS'},
  {t:'19877e686440f627',s:'KCN',y:'EGCS'},{t:'1989808092c6fe47',s:'KCN',y:'EGCS'},
  {t:'19b49c9a268349ee',s:'KCN',y:'EGCS'},{t:'19a5833f35473824',s:'KCN',y:'EGCS'},
  {t:'19aa442a56f3f21b',s:'KCN',y:'EGCS'},{t:'1919c62c214e88bf',s:'KDB',y:'BWTS'},
  {t:'1938b89575f561b2',s:'KDB',y:'BWTS'},{t:'194176e6e4359ccd',s:'KDB',y:'BWTS'},
  {t:'1941a8c78d0c49ba',s:'KDB',y:'BWTS'},{t:'19cb857a82b74902',s:'KDB',y:'BWTS'},
  {t:'19cfebba06f55d9f',s:'KDB',y:'BWTS'},{t:'19dcd18efd64e6a9',s:'KDB',y:'EGCS'},
  {t:'19ddd76aa0b18ca1',s:'KDB',y:'BWTS'},{t:'19f178d4548bc489',s:'KDB',y:'EGCS'},
  {t:'19c9c9ba8bc7b5bc',s:'KDE',y:'EGCS'},{t:'19d3d686ea1f9487',s:'KDE',y:'EGCS'},
  {t:'19eb1068dc3acebc',s:'KDE',y:'EGCS'},{t:'1936b08e4baf9b0e',s:'KHM',y:'BWTS'},
  {t:'19a5829b785d8198',s:'KJA',y:'EGCS'},{t:'18e98e43b1bc8f5c',s:'KMB',y:'BWTS'},
  {t:'19947ae790aa6965',s:'KMB',y:'BWTS'},{t:'199478be104ffa29',s:'KMB',y:'BWTS'},
  {t:'19cb2c20f9c18fe8',s:'KMB',y:'EGCS'},{t:'19cbcb60aed2d65e',s:'KMB',y:'EGCS'},
  {t:'19ccce5ebd66352a',s:'KMB',y:'BWTS'},{t:'19d27b6b3a9e75df',s:'KMB',y:'BWTS'},
  {t:'19abdae1767630e5',s:'KMN',y:'EGCS'},{t:'191a1b8ae751f9f2',s:'KMU',y:'BWTS'},
  {t:'192d15c4b4801889',s:'KMU',y:'BWTS'},{t:'19319995cbda24b7',s:'KMU',y:'BWTS'},
  {t:'1933ce3f5ac682f1',s:'KMU',y:'BWTS'},{t:'197a4357a5a143e3',s:'KMU',y:'BWTS'},
  {t:'19959f447f9b6e31',s:'KMU',y:'BWTS'},{t:'19a9a5af11aafb52',s:'KMU',y:'EGCS'},
  {t:'19b8cf61eeedb961',s:'KMU',y:'EGCS'},{t:'19d380add215d016',s:'KMU',y:'BWTS'},
  {t:'19f113234af860f1',s:'KMU',y:'EGCS'},{t:'18e4f4f580f15a74',s:'KNB',y:'BWTS'},
  {t:'18ee42e3d7c07b54',s:'KNB',y:'BWTS'},{t:'1902e7a87157f8af',s:'KNB',y:'BWTS'},
  {t:'191f86b383dc9fa0',s:'KNB',y:'BWTS'},{t:'1931f745e293e22f',s:'KNB',y:'BWTS'},
  {t:'195b6071d2830bed',s:'KNB',y:'BWTS'},{t:'1995080ddf9731fe',s:'KNB',y:'BWTS'},
  {t:'199cc80e90e10bff',s:'KNB',y:'BWTS'},{t:'19a32d39736cbdb5',s:'KNB',y:'EGCS'},
  {t:'19c646cb27ea4c0a',s:'KNB',y:'BWTS'},{t:'19eedcf529995c0f',s:'KNB',y:'EGCS'},
  {t:'18fc4800281e456d',s:'KNH',y:'BWTS'},{t:'19a5c46e3f19aef1',s:'KNH',y:'EGCS'},
  {t:'19a9ef613dbc0c2d',s:'KNH',y:'BWTS'},{t:'19c7a30bceccc31a',s:'KNH',y:'EGCS'},
  {t:'19366edcbfbd1760',s:'KPS',y:'BWTS'},{t:'198a2437d75c53da',s:'KSG',y:'BWTS'},
  {t:'1994aaa370bef3eb',s:'KSH',y:'BWTS'},
  {t:'18e50f93151b0390',s:'KSL',y:'BWTS'},{t:'192f5bc66d2114d0',s:'KSL',y:'BWTS'},
  {t:'1935cf1405f8fbae',s:'KSL',y:'BWTS'},{t:'19bd9511c581ba89',s:'KSL',y:'BWTS'},
  // 19cb83defb709cf5 = KSL BWTS Annual Calibration (CSP) → Calibrations로 이관, Repairs 제외
  {t:'19d9a39ff3bb7a60',s:'KSL',y:'BWTS'},
  {t:'190a0ce690401005',s:'KSZ',y:'BWTS'},{t:'19143e204e924973',s:'KSZ',y:'BWTS'},
  {t:'191d40153bdbbd00',s:'KSZ',y:'BWTS'},{t:'192642b218afdbd8',s:'KSZ',y:'BWTS'},
  {t:'1936ace6267c16ba',s:'KSZ',y:'BWTS'},{t:'193709b8b0b24534',s:'KSZ',y:'BWTS'},
  {t:'194aa671a2724d9c',s:'KSZ',y:'BWTS'},{t:'199db2c82242b1fa',s:'KSZ',y:'EGCS'},
  {t:'19a24120866545a6',s:'KSZ',y:'EGCS'},{t:'19ae74a82cd4f955',s:'KSZ',y:'EGCS'},
  {t:'19685e4d7e06e35a',s:'KUS',y:'BWTS'},
  {t:'19208e2b300344df',s:'FLEET',y:'BWTS'},{t:'192e55cb774df38c',s:'FLEET',y:'BWTS'},
  {t:'1936ab5d87e597ea',s:'FLEET',y:'BWTS'},{t:'19930b7ee1b524bf',s:'FLEET',y:'BWTS'},
  {t:'199a3e52ad1304c7',s:'KMU',y:'EGCS'},{t:'19cb6260bca263f0',s:'FLEET',y:'BWTS'},
  {t:'19e62a3a41527f10',s:'FLEET',y:'BWTS'}
];

/**
 * Gmail 스레드 본문을 읽고 Gemini로 구조화 추출.
 * 반환: {equip, symptom, action, date, skip, reason}
 * skip=true: 견적/인보이스/일반안내 → 임포트 제외.
 */
function enrichThread_(threadId, meta) {
  var thread, msgs;
  try {
    thread = GmailApp.search('rfc822msgid:' + threadId);
    if (!thread.length) {
      // threadId로 직접 검색 — hex ID는 GmailApp에서 지원
      try { thread = [GmailApp.getThreadById(threadId)]; } catch (e2) { thread = []; }
    }
  } catch (e) { thread = []; }
  if (!thread.length || !thread[0]) return { skip: true, reason: 'thread not found' };

  msgs = thread[0].getMessages();
  if (!msgs.length) return { skip: true, reason: 'no messages' };

  // ekmtc.com 발신 메일 제외, 메이커/업체 발신만
  var extMsg = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    var from = '';
    try { from = msgs[i].getFrom() || ''; } catch (e) {}
    if (!/ekmtc\.com/i.test(from)) { extMsg = msgs[i]; break; }
  }
  if (!extMsg) extMsg = msgs[0]; // fallback

  var subject = '';
  try { subject = extMsg.getSubject() || ''; } catch (e) {}
  var body = emailBodyTop_(extMsg);
  var text = subject + '\n' + body;

  // 빠른 필터: 견적/인보이스
  if (/(견적서|INQUIRY|invoice|인보이스|계산서|발주서|ORDER SHEET)/i.test(text) &&
      !/(완료|조치|교체|점검|수리|report)/i.test(text)) {
    return { skip: true, reason: 'quote/invoice' };
  }

  // Gemini 구조화 추출
  var prompt =
    '아래는 선박 ' + (meta.s || '') + '(' +
    (SHIP_SEED[meta.s] && SHIP_SEED[meta.s].name || '') +
    ')의 ' + (meta.y || '') + ' 관련 메일이다.\n' +
    'JSON으로만 답하라 (마크다운 금지):\n' +
    '{"skip":false, "equip":"장비명(구체적)", ' +
    '"symptom":"결함/사유 1줄(예: FMU Fail, TRO 편차 등)", ' +
    '"action":"수행 조치 1~2줄(교체부품·결과 포함)", ' +
    '"date":"YYYY-MM-DD 실제 작업일"}\n' +
    '견적서/발주서/인보이스/일반안내면 {"skip":true,"reason":"이유"}\n' +
    '장비명: TRO Sensor, FMU, ECU, CPC, pH Sensor, ' +
    'APU, Sol.Valve, CLX Reagent 등 구체적으로.\n' +
    '증상: 구체적 현상(Fail, 편차, 누수 등). ' +
    '"정비" "서비스" 같은 모호한 표현 금지.\n' +
    '조치: "점검 완료" 같은 모호한 표현 금지. ' +
    '실제 한 작업(교체, 교정, 업데이트 등) 기술.\n\n' +
    '제목: ' + subject + '\n본문:\n' + body.substring(0, 6000);
  var raw = geminiCall_(prompt);
  if (raw) {
    raw = raw.replace(/^```json\s*/i, '')
      .replace(/```\s*$/, '').trim();
    try { return JSON.parse(raw); } catch (pe) {}
  }

  // Gemini 실패 시 fallback: 휴리스틱
  var equip = cleanSubject_(subject);
  var dateStr = '';
  try { dateStr = Utilities.formatDate(extMsg.getDate(), 'Asia/Seoul', 'yyyy-MM-dd'); }
  catch (e) {}
  return { skip: false, equip: equip || meta.y, symptom: '', action: '(메일 기반 자동수집)',
    date: dateStr };
}

/**
 * 85건 일괄 임포트. dryRun=true면 로그만.
 * 6분 제한 대비 배치(batch) 처리 — 1회 호출에 최대 N건.
 */
function enrichImport_(dryRun, startIdx, batchSize) {
  startIdx = startIdx || 0;
  batchSize = batchSize || 15;  // Gemini rate limit 고려
  var end = Math.min(startIdx + batchSize, IMPORT_THREADS.length);

  var added = [], skipped = [], errors = [];
  var existing = {};
  readAll_('Repairs').forEach(function (r) {
    var key = r.shipCode + '|' + (r.system || 'BWTS') + '|' + toDateStr_(r.date);
    existing[key] = true;
  });

  for (var i = startIdx; i < end; i++) {
    var it = IMPORT_THREADS[i];
    try {
      var result = enrichThread_(it.t, it);
      if (result.skip) {
        skipped.push(i + '. ' + it.s + ' ' + it.y + ': ' + (result.reason || 'skip'));
        continue;
      }
      var date = result.date || it.date || '';
      var key = it.s + '|' + it.y + '|' + toDateStr_(date);
      if (existing[key]) {
        skipped.push(i + '. ' + it.s + ' ' + date + ' 이미 등록');
        continue;
      }
      var line = it.s + ' | ' + it.y + ' | ' + date + ' | ' +
        (result.equip || '').substring(0, 40) + ' | ' +
        (result.action || '').substring(0, 50);

      if (!dryRun && it.s !== 'FLEET') {
        addRepair({
          id: 'ENRICH_' + it.t.substring(0, 16),
          shipCode: it.s, system: it.y, date: date,
          equip: result.equip || it.y,
          stage: 'done',
          symptom: result.symptom || '',
          action: result.action || '(메일 기반 수집)',
          sourceMsgId: 'thread:' + it.t
        });
      }
      added.push(i + '. ' + line);
      existing[key] = true;
    } catch (e) {
      errors.push(i + '. ' + it.s + ': ' + String(e).slice(0, 80));
    }
  }

  if (!dryRun && added.length) {
    try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); }
  }

  var report = {
    dryRun: dryRun, range: startIdx + '~' + (end - 1),
    total: IMPORT_THREADS.length, processed: end - startIdx,
    remaining: IMPORT_THREADS.length - end,
    addedN: added.length, added: added,
    skippedN: skipped.length, skipped: skipped,
    errors: errors
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

// 실행 래퍼 — 15건씩 배치. startIdx를 바꿔가며 반복 실행.
function run_enrichImportDRY_0()  { return enrichImport_(true, 0, 15); }
function run_enrichImportDRY_15() { return enrichImport_(true, 15, 15); }
function run_enrichImportDRY_30() { return enrichImport_(true, 30, 15); }
function run_enrichImportDRY_45() { return enrichImport_(true, 45, 15); }
function run_enrichImportDRY_60() { return enrichImport_(true, 60, 15); }
function run_enrichImportDRY_75() { return enrichImport_(true, 75, 15); }
function run_enrichImportREAL_0()  { return enrichImport_(false, 0, 15); }
function run_enrichImportREAL_15() { return enrichImport_(false, 15, 15); }
function run_enrichImportREAL_30() { return enrichImport_(false, 30, 15); }
function run_enrichImportREAL_45() { return enrichImport_(false, 45, 15); }
function run_enrichImportREAL_60() { return enrichImport_(false, 60, 15); }
function run_enrichImportREAL_75() { return enrichImport_(false, 75, 15); }

/* ══════════════════════════════════════════════════════════════
   ENRICH_ 레코드 action 보강 (Gemini 재처리)
   기존 ENRICH_ 중 action이 비어있는 것들을 Gmail 본문 재읽기 → Gemini 추출.
   run_enrichActionDRY() → 검토 → run_enrichActionREAL()
   ══════════════════════════════════════════════════════════════ */

/** ENRICH_ 레코드 action 보강. dryRun=true면 로그만. 1회 최대 10건. */
function enrichAction_(dryRun) {
  var key = PropertiesService.getScriptProperties()
    .getProperty(GEMINI_KEY_PROP);
  if (!key) return { error: 'GEMINI_API_KEY 미설정' };

  var rows = readAll_('Repairs');
  var LIMIT = 10, n = 0, updated = [], skipped = [],
      errors = [], remaining = 0;

  // IMPORT_THREADS lookup: threadId → meta
  var threadMeta = {};
  IMPORT_THREADS.forEach(function (it) {
    threadMeta[it.t] = it;
  });

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r.id).indexOf('ENRICH_') !== 0) continue;
    // action이 비어있거나 기본값인 것만
    var act = String(r.action || '');
    if (act && act !== '(메일 기반 자동수집)' &&
        act !== '(메일 기반 수집)') continue;
    if (n >= LIMIT) { remaining++; continue; }

    // sourceMsgId에서 threadId 추출
    var tid = String(r.sourceMsgId || '')
      .replace('thread:', '');
    if (!tid) {
      skipped.push(r.id + ': no threadId');
      continue;
    }

    var meta = threadMeta[tid] ||
      { s: r.shipCode, y: r.system };
    try {
      var result = enrichThread_(tid, meta);
      if (result.skip) {
        skipped.push(r.id + ' ' + r.shipCode +
          ': skip(' + (result.reason || '') + ')');
        continue;
      }
      var patch = {};
      if (result.action && result.action !== '(메일 기반 자동수집)' &&
          result.action !== '(메일 기반 수집)') {
        patch.action = result.action;
      }
      if (result.symptom) patch.symptom = result.symptom;
      if (result.equip && result.equip !== r.system) {
        patch.equip = result.equip;
      }

      if (Object.keys(patch).length === 0) {
        skipped.push(r.id + ' ' + r.shipCode +
          ': Gemini returned no detail');
        continue;
      }

      var line = r.id + ' ' + r.shipCode + ' ' +
        r.system + ' | ' +
        (patch.action || '').substring(0, 60);
      if (!dryRun) {
        updateRepair(r.id, patch);
      }
      updated.push(line);
      n++;
    } catch (e) {
      errors.push(r.id + ': ' + String(e).slice(0, 80));
    }
  }

  if (!dryRun && updated.length) {
    try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); }
  }

  var rep = {
    dryRun: dryRun, updatedN: updated.length,
    updated: updated, skippedN: skipped.length,
    skipped: skipped, errors: errors,
    remaining: remaining
  };
  Logger.log(JSON.stringify(rep, null, 2));
  return rep;
}

function run_enrichActionDRY()  { return enrichAction_(true); }
function run_enrichActionREAL() { return enrichAction_(false); }

/* ══════════════════════════════════════════════════════════════
   ekmtc.com 발신 본선 조치 안내 메일 수집
   "[KMTC SM][ETP]" 패턴 메일 → 본문에서 Gemini로 수리 내용 추출 → DB 등록
   run_collectEtpDRY() → 검토 → run_collectEtpREAL()
   ══════════════════════════════════════════════════════════════ */

/** ETP 메일 검색 쿼리 */
function etpQuery_(window) {
  var w = window || 'newer_than:2y';
  return 'subject:"[KMTC SM][ETP]" ' + w;
}

/** @deprecated — use parseShipCode_ */
function etpParseShipCode_(subject) {
  return parseShipCode_(subject, true) || null;
}

/** ETP 메일 시스템 추출: EGCS/BWTS 키워드 기반 */
function etpParseSystem_(text) {
  if (/(EGCS|scrubber|스크러버)/i.test(text)) return 'EGCS';
  if (/(BWTS|ballast|평형수)/i.test(text)) return 'BWTS';
  return 'BWTS'; // default
}

/**
 * ETP 메일 수집 메인.
 * dryRun=true면 로그만, false면 DB 등록.
 */
function collectEtp_(dryRun, opts) {
  opts = opts || {};
  var window = opts.window || 'newer_than:2y';
  var maxThreads = opts.maxThreads || 200;
  var BATCH = opts.batch || 20;
  var query = etpQuery_(window);
  var allMsgs = [];
  var page = 100, start = 0;
  while (start < maxThreads) {
    var threads = GmailApp.search(
      query, start, Math.min(page, maxThreads - start));
    if (!threads.length) break;
    for (var t = 0; t < threads.length; t++) {
      var ms = threads[t].getMessages();
      for (var m = 0; m < ms.length; m++) {
        allMsgs.push(ms[m]);
      }
    }
    start += threads.length;
    if (threads.length < page) break;
  }

  // 기존 레코드 중복 체크용
  var existing = {};
  readAll_('Repairs').forEach(function (r) {
    if (r.sourceMsgId) existing[r.sourceMsgId] = true;
    var k = r.shipCode + '|' + (r.system || 'BWTS') +
      '|' + toDateStr_(r.date);
    existing[k] = true;
  });

  var added = [], skipped = [], errors = [];
  var processed = 0;

  for (var i = 0; i < allMsgs.length && processed < BATCH; i++) {
    var msg = allMsgs[i];
    var msgId = '';
    try { msgId = msg.getId(); } catch (e) { continue; }

    // 중복 체크 (msgId 기준)
    if (existing['etp:' + msgId]) {
      skipped.push(msgId + ': 이미 등록');
      continue;
    }

    var subject = '';
    try { subject = msg.getSubject() || ''; } catch (e) {}
    var body = emailBodyTop_(msg);
    var text = subject + '\n' + body;

    var shipCode = etpParseShipCode_(subject);
    if (!shipCode) {
      skipped.push(msgId + ': 선박코드 미식별 — ' +
        subject.substring(0, 50));
      continue;
    }

    var system = etpParseSystem_(text);
    var dateStr = '';
    try {
      dateStr = Utilities.formatDate(
        msg.getDate(), 'Asia/Seoul', 'yyyy-MM-dd');
    } catch (e) {}

    // 날짜 기준 중복 체크
    var dk = shipCode + '|' + system + '|' + dateStr;
    if (existing[dk]) {
      skipped.push(msgId + ' ' + shipCode + ' ' +
        dateStr + ': 날짜 중복');
      continue;
    }

    // Gemini 구조화 추출
    var equip = '', symptom = '', action = '';
    var etpPrompt =
      '아래는 선박 ' + shipCode + '(' +
      (SHIP_SEED[shipCode] &&
        SHIP_SEED[shipCode].name || '') +
      ')의 ' + system +
      ' 관련 본선 조치 안내 메일이다.\n' +
      'JSON으로만 답하라 (마크다운 금지):\n' +
      '{"equip":"장비명(구체적)", ' +
      '"symptom":"결함/사유(구체적 현상)", ' +
      '"action":"수행 조치(교체부품·결과 포함)"}\n' +
      '장비명: TRO Sensor, FMU, ECU, CPC 등.\n' +
      '"정비" "서비스" 같은 모호한 표현 금지. ' +
      '실제 현상과 조치를 기술.\n\n' +
      '제목: ' + subject + '\n본문:\n' +
      body.substring(0, 6000);
    var etpRaw = geminiCall_(etpPrompt);
    if (etpRaw) {
      etpRaw = etpRaw.replace(/^```json\s*/i, '')
        .replace(/```\s*$/, '').trim();
      try {
        var parsed = JSON.parse(etpRaw);
        equip = parsed.equip || '';
        symptom = parsed.symptom || '';
        action = parsed.action || '';
      } catch (pe) {}
    }

    var line = shipCode + ' | ' + system + ' | ' +
      dateStr + ' | ' +
      (equip || '').substring(0, 40) + ' | ' +
      (action || '').substring(0, 50);

    if (!dryRun) {
      addRepair({
        id: 'ETP_' + msgId.substring(0, 16),
        shipCode: shipCode, system: system,
        date: dateStr,
        equip: equip || system,
        stage: 'done',
        symptom: symptom,
        action: action || '(본선 조치 안내)',
        sourceMsgId: 'etp:' + msgId
      });
    }
    added.push((i + 1) + '. ' + line);
    existing[dk] = true;
    existing['etp:' + msgId] = true;
    processed++;
  }

  if (!dryRun && added.length) {
    try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); }
  }

  var rep = {
    dryRun: dryRun, query: query,
    totalMsgs: allMsgs.length,
    addedN: added.length, added: added,
    skippedN: skipped.length, skipped: skipped,
    errors: errors,
    remaining: allMsgs.length - processed - skipped.length
  };
  Logger.log(JSON.stringify(rep, null, 2));
  return rep;
}

function run_collectEtpDRY() {
  return collectEtp_(true);
}
function run_collectEtpREAL() {
  return collectEtp_(false);
}

/* ══════════════════════════════════════════════════════════════
   메이커 텍스트 메일 수집 (PDF 첨부 없는 기술 메일)
   techcross/alfalaval/lastech 등 발신 메일 중 수리·서비스 관련 →
   Gemini로 구조화 추출 → Repairs DB 등록.
   ══════════════════════════════════════════════════════════════ */

/** 메이커 텍스트 메일 검색 쿼리 */
function makerTextQuery_(window) {
  var w = window || 'newer_than:6m';
  var makers = '(from:techcross.com OR from:alfalaval.com OR ' +
    'from:lastech.kr OR from:unionkr.com OR ' +
    'from:hyundaimaterials.com OR from:hhi-power.com OR ' +
    'from:worldpanasia.com)';
  var topics = '(subject:S/W OR subject:수리 OR subject:조치 OR ' +
    'subject:교체 OR subject:점검 OR subject:안내 OR ' +
    'subject:report OR subject:서비스 OR subject:수정 OR ' +
    'subject:에러 OR subject:error OR subject:fault OR ' +
    'subject:alarm OR subject:확인)';
  var exclude = '-subject:(invoice OR quotation OR 견적 OR ' +
    '계산서 OR 정산 OR 발주 OR 인보이스 OR INQUIRY)';
  return makers + ' ' + topics + ' ' + exclude + ' ' + w;
}

/**
 * 메이커 텍스트 메일 수집. PDF 없어도 본문 기반 처리.
 */
function collectMakerText_(dryRun, opts) {
  opts = opts || {};
  var window = opts.window || 'newer_than:6m';
  var BATCH = opts.batch || 20;
  var props = PropertiesService.getScriptProperties();

  var query = makerTextQuery_(window);
  var allMsgs = [];
  var page = 100, start = 0, maxThreads = 200;
  while (start < maxThreads) {
    var threads = GmailApp.search(
      query, start, Math.min(page, maxThreads - start));
    if (!threads.length) break;
    for (var t = 0; t < threads.length; t++) {
      var ms = threads[t].getMessages();
      // 메이커 발신 메시지만 수집
      for (var m = 0; m < ms.length; m++) {
        var from = '';
        try { from = ms[m].getFrom() || ''; } catch (e) {}
        if (/(techcross|alfalaval|lastech|unionkr|hyundaimaterials|hhi-power|worldpanasia)/i.test(from)) {
          allMsgs.push(ms[m]);
          break; // 스레드당 1건
        }
      }
    }
    start += threads.length;
    if (threads.length < page) break;
  }

  // 기존 레코드 중복 체크
  var existing = {};
  readAll_('Repairs').forEach(function (r) {
    if (r.sourceMsgId) {
      // sourceMsgId에서 순수 msgId 추출
      var mid = String(r.sourceMsgId).split(' ')[0]
        .replace('etp:', '').replace('mkr:', '');
      existing[mid] = true;
    }
  });

  var added = [], skipped = [], errors = [];
  var processed = 0;

  for (var i = 0; i < allMsgs.length && processed < BATCH;
       i++) {
    var msg = allMsgs[i];
    var msgId = '';
    try { msgId = msg.getId(); } catch (e) { continue; }

    // 중복 체크
    if (existing[msgId] ||
        props.getProperty(GMDONE_PREFIX + msgId)) {
      continue;
    }

    var subject = '';
    try { subject = msg.getSubject() || ''; } catch (e) {}
    var body = emailBodyTop_(msg);
    var text = subject + '\n' + body;

    // 선박코드 추출
    var shipCode = etpParseShipCode_(subject) ||
      etpParseShipCode_(body.substring(0, 2000));
    if (!shipCode) {
      skipped.push(msgId.substring(0, 8) +
        ': 선박미식별 — ' + subject.substring(0, 50));
      continue;
    }

    var system = etpParseSystem_(text);
    var dateStr = '';
    try {
      dateStr = Utilities.formatDate(
        msg.getDate(), 'Asia/Seoul', 'yyyy-MM-dd');
    } catch (e) {}

    // Gemini 구조화 추출
    var equip = '', symptom = '', action = '';
    var mkrPrompt =
      '아래는 선박 ' + shipCode + '(' +
      (SHIP_SEED[shipCode] &&
        SHIP_SEED[shipCode].name || '') +
      ')의 ' + system +
      ' 관련 메이커/서비스 업체 발신 기술 메일이다.\n' +
      'JSON으로만 답하라 (마크다운 금지):\n' +
      '{"equip":"장비명(구체적)", ' +
      '"symptom":"결함/사유(구체적 현상)", ' +
      '"action":"조치/안내(교체부품·결과 포함)"}\n' +
      '장비명: TRO Sensor, FMU, CPC S/W 등.\n' +
      '"정비" "서비스" 같은 모호한 표현 금지. ' +
      '실제 현상과 조치를 기술.\n' +
      '수리/서비스와 무관한 일반 안내면 ' +
      '{"skip":true,"reason":"이유"}\n\n' +
      '제목: ' + subject + '\n본문:\n' +
      body.substring(0, 6000);
    var mkrRaw = geminiCall_(mkrPrompt);
    if (mkrRaw) {
      mkrRaw = mkrRaw.replace(/^```json\s*/i, '')
        .replace(/```\s*$/, '').trim();
      try {
        var parsed = JSON.parse(mkrRaw);
        if (parsed.skip) {
          skipped.push(shipCode + ': skip(' +
            (parsed.reason || '') + ')');
          if (!dryRun) props.setProperty(
            GMDONE_PREFIX + msgId, '1');
          processed++;
          continue;
        }
        equip = parsed.equip || '';
        symptom = parsed.symptom || '';
        action = parsed.action || '';
      } catch (pe) {}
    }

    if (!equip && !action) {
      equip = cleanSubject_(subject);
      action = '(메이커 메일 기반 수집)';
    }

    var line = shipCode + ' | ' + system + ' | ' +
      dateStr + ' | ' +
      (equip || '').substring(0, 40) + ' | ' +
      (action || '').substring(0, 50);

    if (!dryRun) {
      addRepair({
        id: 'MKR_' + msgId.substring(0, 16),
        shipCode: shipCode, system: system,
        date: dateStr,
        equip: equip || system,
        stage: 'done',
        symptom: symptom,
        action: action || '(메이커 메일 수집)',
        sourceMsgId: 'mkr:' + msgId
      });
      props.setProperty(GMDONE_PREFIX + msgId, '1');
    }
    added.push((processed + 1) + '. ' + line);
    processed++;
  }

  if (!dryRun && added.length) {
    try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); }
  }

  var rep = {
    dryRun: dryRun, query: query,
    totalMsgs: allMsgs.length,
    addedN: added.length, added: added,
    skippedN: skipped.length, skipped: skipped,
    errors: errors
  };
  Logger.log(JSON.stringify(rep, null, 2));
  return rep;
}

function run_collectMakerTextDRY() {
  return collectMakerText_(true);
}
function run_collectMakerTextREAL() {
  return collectMakerText_(false);
}

/* ══════════════════════════════════════════════════════════════
   BWTS 검교정 Gmail 자동 동기화
   Gmail에서 BWTS calibration 서비스리포트/인증서 메일 스캔 →
   Gemini로 실제 작업일 추출 → Calibrations 갱신 + Repairs 오등록 정리.
   run_syncBwtsCalDRY() → 검토 → run_syncBwtsCalREAL()
   ══════════════════════════════════════════════════════════════ */

/** BWTS 검교정 관련 Gmail 검색 쿼리 */
function bwtsCalQuery_(window) {
  var w = window || 'newer_than:1y';
  return '(subject:"BWTS" (subject:"calibration" OR ' +
    'subject:"CSP" OR subject:"compliance") OR ' +
    'subject:"검교정 CERT") ' +
    'has:attachment ' + w;
}

/** @deprecated — use parseShipCode_ */
function calParseShipCode_(subject) {
  return parseShipCode_(subject, true) || null;
}

/**
 * 메일에서 검교정 완료 여부 판별 + 작업일 추출.
 * 서비스리포트/CERT/Compliance Certificate 첨부가 있으면 완료로 판정.
 * Gemini로 실제 작업일 추출 시도, 실패시 메일 날짜 사용.
 */
function calExtractDate_(msgs, shipCode) {
  // 서비스리포트/CERT 첨부가 있는 메시지 찾기
  var certMsg = null, certBlob = null;
  for (var i = msgs.length - 1; i >= 0; i--) {
    var m = msgs[i];
    var from = '';
    try { from = m.getFrom() || ''; } catch (e) {}
    // 메이커/업체 발신만 (ekmtc 제외)
    if (/ekmtc\.com/i.test(from)) continue;
    var atts = m.getAttachments();
    for (var a = 0; a < atts.length; a++) {
      var fn = atts[a].getName() || '';
      if (!/\.pdf$/i.test(fn)) continue;
      // 우선: cert/report 키워드 매칭
      var isCert = /(service.report|cert|compliance|calibration|report)/i
          .test(fn) &&
          !/(invoice|quot|order|PO\b|draft)/i.test(fn);
      // 차선: 메이커 발신 PDF 중 invoice가 아닌 것
      var isMakerPdf = !isCert &&
          /(alfalaval|techcross|lastech)/i.test(from) &&
          !/(invoice|quot|order|PO\b|draft)/i.test(fn);
      if (isCert || isMakerPdf) {
        certMsg = m;
        certBlob = atts[a].copyBlob();
        break;
      }
    }
    if (certMsg) break;
  }

  if (!certMsg) return null; // 완료 증빙 없음

  // 1차: 파일명에서 날짜 추출 (가장 빠름, API 호출 없음)
  var calDate = '';
  var allAtts = certMsg.getAttachments();
  for (var k = 0; k < allAtts.length; k++) {
    var fn2 = allAtts[k].getName() || '';
    if (!/\.pdf$/i.test(fn2)) continue;
    // YYYYMMDD 패턴 (예: 20260515)
    var fm8 = fn2.match(/(\d{4})(\d{2})(\d{2})/);
    if (fm8 && parseInt(fm8[1]) >= 2024) {
      calDate = fm8[1] + '-' + fm8[2] + '-' + fm8[3];
      break;
    }
    // _YYMMDD 패턴 (예: _260203)
    var fm6 = fn2.match(/_(\d{2})(\d{2})(\d{2})\b/);
    if (fm6 && parseInt(fm6[1]) >= 24 &&
        parseInt(fm6[1]) <= 27) {
      calDate = '20' + fm6[1] + '-' + fm6[2] + '-' + fm6[3];
      break;
    }
  }

  // 2차: Gemini PDF 날짜 추출 (1회만, summarize 생략)
  if (!calDate && certBlob) {
    var dateRaw = geminiCall_(
      '이 PDF는 선박 ' + shipCode +
      '의 BWTS 검교정 서비스리포트/인증서이다.' +
      ' 실제 작업 수행일을 YYYY-MM-DD 형식으로만' +
      ' 답하라. 날짜만, 다른 텍스트 금지.',
      { temp: 0, maxTokens: 50, pdfBlob: certBlob,
        retryOn429: false });
    if (dateRaw) {
      var dm2 = dateRaw.match(
        /(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/);
      if (dm2) calDate = dm2[1] + '-' +
        ('0' + dm2[2]).slice(-2) + '-' +
        ('0' + dm2[3]).slice(-2);
    }
  }

  // 메일 수신일은 사용하지 않음 — CERT/리포트 실제 날짜만 사용

  // 모든 CERT/리포트 PDF 수집 (Drive 저장용)
  var certBlobs = [];
  if (certMsg) {
    var allAtts = certMsg.getAttachments();
    for (var ca = 0; ca < allAtts.length; ca++) {
      var cfn = allAtts[ca].getName() || '';
      if (!/\.pdf$/i.test(cfn)) continue;
      if (/(invoice|quot|order|PO\b|draft)/i.test(cfn)) continue;
      certBlobs.push({
        blob: allAtts[ca].copyBlob(), name: cfn });
    }
  }

  return { date: calDate, msgId: certMsg.getId(),
    certBlobs: certBlobs };
}

/** 단일 선박 검교정 업데이트 + CERT 파일 Drive 저장 */
function calUpdateOne_(shipCode, calDate, cals,
    dryRun, updated, skipped, certBlobs) {
  var cur = cals[shipCode];
  var curDate = cur ? toDateStr_(cur.lastCalibration) : '';

  // CERT 파일 Drive 저장 (날짜 비교와 무관하게 항상)
  var savedFiles = [];
  if (!dryRun && certBlobs && certBlobs.length) {
    try {
      var folderId = getEventFolder_(
        'BWTS', shipCode, calDate || curDate || '',
        'Annual Calibration');
      for (var f = 0; f < certBlobs.length; f++) {
        var cb = certBlobs[f];
        if (driveFileExistsByName_(folderId, cb.name)) {
          continue; // 이미 저장됨
        }
        var created = Drive.Files.create(
          { name: cb.name, parents: [folderId] },
          cb.blob,
          { supportsAllDrives: true,
            fields: 'id,name,webViewLink' });
        savedFiles.push(created.name);
      }
    } catch (e) {
      // Drive 저장 실패해도 날짜 업데이트는 진행
    }
  }

  var fileInfo = savedFiles.length ?
    ' [파일 ' + savedFiles.length + '건 저장]' : '';

  if (calDate && calDate > (curDate || '')) {
    var line = shipCode + ': ' + (curDate || '없음') +
      ' → ' + calDate + fileInfo;
    if (!dryRun) {
      var calId = shipCode + '_BWTSCAL';
      upsert_('Calibrations', 'id', {
        id: calId, shipCode: shipCode, equip: '연간검교정',
        lastCalibration: calDate, intervalMonths: 12,
        note: cur ? (cur.note || '') : '',
        updatedAt: new Date().toISOString(),
        system: 'BWTS'
      });
    }
    cals[shipCode] = { lastCalibration: calDate };
    updated.push(line);
  } else if (calDate) {
    skipped.push(shipCode + ': ' + calDate +
      ' ≤ 기존 ' + curDate + fileInfo);
  } else {
    skipped.push(shipCode + ': 날짜 추출 실패' + fileInfo);
  }
}

/** 멀티-선박 스레드 감지: 첨부 파일명에서 선박명+날짜 추출 */
function calDetectMultiShip_(msgs) {
  var results = [];
  var seen = {};
  for (var i = 0; i < msgs.length; i++) {
    var from = '';
    try { from = msgs[i].getFrom() || ''; } catch (e) {}
    if (/ekmtc\.com/i.test(from)) continue;
    var atts;
    try { atts = msgs[i].getAttachments(); } catch (e) { continue; }
    for (var a = 0; a < atts.length; a++) {
      var fn = atts[a].getName() || '';
      if (!/\.pdf$/i.test(fn)) continue;
      if (/(invoice|quot|order|draft)/i.test(fn)) continue;
      // 파일명에서 선박명 추출
      var sc = calParseShipCode_(fn);
      if (!sc || sc === 'FLEET' || seen[sc]) continue;
      // 파일명에서 날짜 추출: YYMMDD 패턴
      var dt = '';
      var dm = fn.match(/_(\d{6})\b/);
      if (dm) {
        var yy = parseInt(dm[1].substring(0, 2));
        if (yy >= 24 && yy <= 27) {
          dt = '20' + dm[1].substring(0, 2) + '-' +
            dm[1].substring(2, 4) + '-' +
            dm[1].substring(4, 6);
        }
      }
      // YYYYMMDD 패턴
      if (!dt) {
        var dm2 = fn.match(/(\d{4})(\d{2})(\d{2})/);
        if (dm2 && parseInt(dm2[1]) >= 2024) {
          dt = dm2[1] + '-' + dm2[2] + '-' + dm2[3];
        }
      }
      // "25.09 승선" 패턴은 본문에서 처리 — 파일명 우선
      seen[sc] = true;
      results.push({ shipCode: sc, date: dt,
        certBlobs: [{ blob: atts[a].copyBlob(), name: fn }] });
    }
  }
  return results;
}

/**
 * Gmail → BWTS Calibrations 동기화 메인.
 * dryRun=true면 로그만.
 */
function syncBwtsCal_(dryRun) {
  var query = bwtsCalQuery_();
  var allThreads = [];
  var page = 50, start = 0, cap = 200;
  while (start < cap) {
    var ts = GmailApp.search(
      query, start, Math.min(page, cap - start));
    if (!ts.length) break;
    allThreads = allThreads.concat(ts);
    start += ts.length;
    if (ts.length < page) break;
  }

  // 현재 Calibrations 읽기
  var cals = {};
  readAll_('Calibrations').forEach(function (c) {
    if (c.system === 'BWTS' && c.equip === '연간검교정') {
      cals[c.shipCode] = c;
    }
  });

  var updated = [], skipped = [], errors = [];
  var repairsToClean = [];
  var BATCH = 8; // Gemini + Drive 저장 시 6분 제한 고려
  var processed = 0;

  for (var i = 0; i < allThreads.length && processed < BATCH;
       i++) {
    var thread = allThreads[i];
    var msgs = thread.getMessages();
    if (!msgs.length) continue;

    var subject = '';
    try { subject = msgs[0].getSubject() || ''; } catch (e) {}
    var shipCode = calParseShipCode_(subject);
    // 제목에서 못 찾으면 본문에서 시도
    if (!shipCode) {
      for (var mi = 0; mi < msgs.length; mi++) {
        var body = '';
        try { body = msgs[mi].getPlainBody() || ''; }
        catch (e) {}
        shipCode = calParseShipCode_(
          body.substring(0, 2000));
        if (shipCode) break;
      }
    }
    if (!shipCode || shipCode === 'FLEET') {
      skipped.push('선박미식별: ' +
        subject.substring(0, 60));
      continue;
    }

    // 견적/인보이스/문의/요청만 있는 스레드 제외
    var hasCalKeyword = /(service.report|cert|compliance|완료|송부)/i
      .test(subject);
    var isQuoteOnly = /(견적|quotation|invoice|인보이스)/i
      .test(subject) && !hasCalKeyword;
    var isRequestOnly = /(요청|확인 요청|문의|check.?list|이력 확인)/i
      .test(subject) && !hasCalKeyword;
    if (isQuoteOnly) {
      skipped.push(shipCode + ': 견적/인보이스');
      continue;
    }
    if (isRequestOnly) {
      skipped.push(shipCode + ': 요청/문의 (완료 아님)');
      continue;
    }

    try {
      // 멀티-선박 스레드 감지: 첨부 파일명에 여러 선박명
      var multiShips = calDetectMultiShip_(msgs);
      if (multiShips.length > 1) {
        // 각 선박별로 처리
        for (var ms = 0; ms < multiShips.length; ms++) {
          var mi = multiShips[ms];
          calUpdateOne_(mi.shipCode, mi.date, cals,
            dryRun, updated, skipped, mi.certBlobs);
        }
        processed++;
        continue;
      }

      var result = calExtractDate_(msgs, shipCode);
      if (!result) {
        skipped.push(shipCode + ': CERT/리포트 첨부 없음');
        continue;
      }

      calUpdateOne_(shipCode, result.date, cals,
        dryRun, updated, skipped, result.certBlobs);
      processed++;
    } catch (e) {
      errors.push(shipCode + ': ' +
        String(e).slice(0, 80));
    }
  }

  // Repairs 오등록 정리: BWTS calibration/CSP 키워드 + CERT 첨부
  var repairsCleaned = [];
  if (!dryRun) {
    var repairs = readAll_('Repairs');
    for (var r = repairs.length - 1; r >= 0; r--) {
      var rep = repairs[r];
      if (rep.system !== 'BWTS') continue;
      var txt = (rep.equip || '') + ' ' + (rep.action || '') +
        ' ' + (rep.symptom || '');
      if (/(annual.calibration|CSP|compliance.service|연간검교정)/i
          .test(txt)) {
        var rn = findRow_('Repairs', 'id', rep.id);
        if (rn > 0) {
          sheet_('Repairs').deleteRow(rn);
          repairsCleaned.push(rep.id + ' ' + rep.shipCode);
        }
      }
    }
  }

  if (!dryRun && (updated.length || repairsCleaned.length)) {
    try { exportSnapshot(); } catch (e) { Logger.log('snapshot: ' + e); }
  }

  var report = {
    dryRun: dryRun,
    threadsScanned: allThreads.length,
    updatedN: updated.length, updated: updated,
    skippedN: skipped.length, skipped: skipped,
    errors: errors,
    repairsCleaned: repairsCleaned
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

function run_syncBwtsCalDRY()  { return syncBwtsCal_(true); }
function run_syncBwtsCalREAL() { return syncBwtsCal_(false); }

/* ══════════════════════════════════════════════════════════════
   메일 관리대장 (MailLog) — 별도 시트에서 읽기 + 상태 수정
   수집은 ETP AUTO가 담당. 여기서는 읽기 + 상태/비고 수정만.
   ══════════════════════════════════════════════════════════════ */
var MAILLOG_SS_ID = '1Xk9mHvCog60TYGhvXFAxhsTanrwMJBDyrhMSKazwgz0';
var MAILLOG_SHEET = 'MailLog';
var MAILLOG_COLS = [
  'id','threadId','date','system','shipCode','shipName',
  'keyword','subject','from','mailLink','attachments',
  'note','status','replyCount','lastReply'
];
var MAIL_STATUS_OPTIONS = ['접수','업체','KMTC','완료','정산중'];

function getMailLogSheet_() {
  // 외부 시트 접근 시도 → 실패하면 같은 DB 시트에서 MailLog 탭 찾기
  try {
    var ss = SpreadsheetApp.openById(MAILLOG_SS_ID);
    var sh = ss.getSheetByName(MAILLOG_SHEET);
    if (sh) return sh;
  } catch (e) {
    Logger.log('MailLog 외부 시트 접근 실패: ' + e);
  }
  // 폴백: 같은 DB 시트에서 MailLog 탭
  var local = getSS_().getSheetByName(MAILLOG_SHEET);
  if (local) return local;
  return null;
}

/** 메일 관리대장 전체 읽기 (경량화: 필요 컬럼만, 최대 200행) */
function readMailLog() {
  var sh = getMailLogSheet_();
  if (!sh) return '[]';
  var last = sh.getLastRow();
  if (last < 2) return '[]';
  Logger.log('MailLog rows: ' + (last - 1));
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var values = sh.getRange(2, 1, last - 1, headers.length).getValues();
  var ci = {};
  headers.forEach(function (h, i) { ci[h] = i; });
  function col(row, name) {
    var idx = ci[name]; return idx != null && idx < row.length ? row[idx] : '';
  }
  var rows = [];
  for (var r = 0; r < values.length; r++) {
    var row = values[r];
    var id = col(row, 'id');
    if (!id) continue;
    rows.push({
      id: String(id),
      date: String(col(row, 'date') || ''),
      system: String(col(row, 'system') || ''),
      shipCode: String(col(row, 'shipCode') || ''),
      keyword: String(col(row, 'keyword') || '').substring(0, 30),
      subject: String(col(row, 'subject') || '').substring(0, 80),
      from: String(col(row, 'from') || '').substring(0, 40),
      mailLink: String(col(row, 'mailLink') || ''),
      status: String(col(row, 'status') || ''),
      note: String(col(row, 'note') || '').substring(0, 50),
      replyCount: String(col(row, 'replyCount') || '0'),
      lastReply: String(col(row, 'lastReply') || ''),
      attachments: String(col(row, 'attachments') || '').substring(0, 60),
    });
  }
  rows.sort(function (a, b) {
    return b.date.localeCompare(a.date);
  });
  Logger.log('MailLog returning ' + rows.length + ' rows');
  return JSON.stringify(rows);
}

/** 메일 관리대장 상태/비고 수정 (msgId 기준) */
function updateMailStatus(msgId, patch) {
  requireRole_('editor');
  var sh = getMailLogSheet_();
  var last = sh.getLastRow();
  if (last < 2) return false;
  var headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  var idCol = headers.indexOf('id') + 1;
  if (idCol < 1) return false;
  var ids = sh.getRange(2, idCol, last - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]) === String(msgId)) {
      var rowNum = i + 2;
      if (patch.status !== undefined) {
        var stCol = headers.indexOf('status') + 1;
        if (stCol > 0) sh.getRange(rowNum, stCol).setValue(patch.status);
      }
      if (patch.note !== undefined) {
        var ntCol = headers.indexOf('note') + 1;
        if (ntCol > 0) sh.getRange(rowNum, ntCol).setValue(patch.note);
      }
      return true;
    }
  }
  return false;
}

/** weeklyCalAlert 트리거 제거 (GitHub Actions로 이전) */
function removeCalAlertTrigger() {
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'weeklyCalAlert') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  Logger.log(removed + '개 weeklyCalAlert 트리거 해제');
  return removed;
}
