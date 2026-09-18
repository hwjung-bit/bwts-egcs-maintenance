// 📎 자료 — 앱 밖 자료로 가는 바로가기. 데이터 로드 없음.
//
// IMO 통합본·BSR 대시보드는 Pages 리포 archive/ 에 정적으로 올린다
// (scripts/publish_static.py). 예전엔 GAS 업무관리대장이 드라이브 HTML 을
// ?doc= 로 렌더했는데, 그 앱을 은퇴시키면서 이 경로로 옮겼다.
import { $ } from '../core/dom.js';

const CARDS = [
  { icon: '📰', title: 'IMO 소식·국제해사동향 (통합)', url: 'archive/imo/', target: '_blank',
    note: 'KMC 주간호 전체 아카이브 — 검색·분류·관련도·월 필터. 코워크가 갱신하면 publish_static.py 로 반영.' },
  { icon: '⛽', title: 'BSR 대시보드 (최신)', url: 'archive/bsr/', target: '_blank',
    note: '본선 BUNKER SOUNDING 편차 분석. 매주 화 14:30 자동 빌드 → 이 페이지 갱신.' },
  { icon: '🖥', title: '공무팀 런처', url: 'http://127.0.0.1:8777/', target: '_blank',
    note: '내 PC 전용 — 런처(TOOL1)가 켜져 있을 때만 열림. 다른 PC·폰에선 동작 안 함.' },
  // 제거(2026-09-18): 앱 내부 탭 링크(#bwtsLog — 라우터가 해시 변경을 안 들어 동작 안 함),
  // 업무 DB 시트(은퇴 후 갱신 없음 — 이관 시점 백업일 뿐, 보려면 📋 업무 탭).
];

function mount(root) {
  root.innerHTML = '<div class="wrap" id="linksRoot"></div>';
}

function refresh() {
  $('linksRoot').innerHTML = '<div class="links-grid">' + CARDS.map(c =>
    `<a class="link-card" href="${c.url}"${c.target ? ` target="${c.target}" rel="noopener"` : ''}>` +
    `<div class="lc-title">${c.icon} ${c.title}</div><div class="lc-note">${c.note}</div>` +
    `<div class="lc-url">${c.url}</div></a>`).join('') + '</div>' +
    '<div class="muted" style="margin-top:10px;font-size:11px">archive/ 갱신: <code>python scripts/publish_static.py</code> (내 PC). BSR 은 스케줄러가 자동으로 부른다.</div>';
}

export default { id: 'links', mount, refresh };
