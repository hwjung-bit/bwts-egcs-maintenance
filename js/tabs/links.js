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
  { icon: '🛠', title: 'BWTS 로그 분석 · 검교정 · 선박관리', url: '#bwtsLog', target: '',
    note: '이 앱의 다른 탭. (예전 "BWTS 분석 대시보드" 링크는 여기로 통합됨)' },
  { icon: '🖥', title: '공무팀 런처', url: 'http://127.0.0.1:8777/', target: '_blank',
    note: '내 PC 전용 — 런처(TOOL1)가 켜져 있을 때만 열림. 다른 PC·폰에선 동작 안 함.' },
  { icon: '📄', title: '업무 DB 시트 (백업, 읽기용)', url: 'https://docs.google.com/spreadsheets/d/19GuSBHq_YhyRIkgcClXK0AWfjIlfZ2V1m22w-OWBjkU/edit', target: '_blank',
    note: '2026-09-18 이관 전 업무관리대장 원본. 이제 편집은 📋 업무 탭에서 — 시트는 참고만.' },
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
