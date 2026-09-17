// Lists shared by mail / repairs / status tabs.

export const STATUS_LIST = ['미확인', '확인', '수리준비중', '자재준비중', '방선예정', '완료'];

/* 단계 카드 색 — 키는 STATUS_LIST 에서만 만들어 목록과 어긋나지 않게 한다 */
export const STATUS_COLOR = (() => {
  const byName = { '미확인': 'amber', '확인': 'blue', '완료': 'teal' };
  const out = {};
  STATUS_LIST.forEach(s => { out[s] = byName[s] || ''; });
  return out;
})();

/* 📋 업무 통일 상태 (sql/027 app_unify_status 와 동일). 수리이력 탭은 앱
   전환(5단계)까지 옛 STATUS_LIST(stage)를 그대로 쓴다. */
export const WORK_STATUS = ['대기', '확인', '준비중', '방선예정', '진행', '보류', '완료'];
export const WORK_STATUS_COLOR = {
  '대기': 'amber', '확인': 'blue', '준비중': 'purple', '방선예정': 'green',
  '진행': 'blue', '보류': 'rose', '완료': 'teal',
};

/* 접수 경로 — 메일로 안 들어온 건을 어디서 받았는지 */
export const ORIGIN_LIST = ['카톡', '전화', '구두', '방선', '파일', '기타'];
export const ORIGIN_ICON = { '카톡': '💬', '전화': '☎', '구두': '🗣', '방선': '🚢', '파일': '📥', '기타': '📝' };

/* 현황 탭 */
export const STATUS_OPTS = ['-', '정상', '수리중', '문제'];

export const YEARS = ['2026', '2025', '2024', '2023'];
export const MAIL_CATEGORIES = ['수리요청', '견적', '검교정', 'SR', '부품', 'Invoice', '방선', '인증서'];
export const MAIL_SOURCES = ['본선', '선급', '메이커', '기타'];
