// ⛽ BSR — 본선 BUNKER SOUNDING 편차·비중 분석.
//
// 대시보드 자체는 로컬 파이프라인(D:\CLAUDE CODE\(제작중) 본선 BUNKER SOUNDING 분석)이
// 매주 화 14:30 빌드해 archive/bsr/ 로 publish 한다 (scripts/publish_static.py).
// 이 탭은 그걸 iframe 으로 띄울 뿐 — Supabase 데이터 로드 없음.
// Pages 는 max-age=600 이라 열 때마다 ?t= 를 붙여 항상 최신본을 받는다.
import { $, toast } from '../core/dom.js';

const URL = 'archive/bsr/index.html';

function mount(root) {
  root.innerHTML = `
    <div class="filters" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <b>⛽ BSR 분석</b>
      <span class="muted" id="bsrStamp" style="font-size:12px"></span>
      <div style="flex:1"></div>
      <button class="refresh-btn" id="bsrRun"
        title="새로 들어온 BSR만 읽어 대시보드 재생성·게시 (Claude 안 씀) — kmtcfolder 등록된 PC에서만 작동">▶ 지금 분석</button>
      <button class="refresh-btn" id="bsrReload">🔄 새로고침</button>
      <a href="${URL}" target="_blank" rel="noopener"
        style="text-decoration:none;background:#fff7ed;border:1px solid #fdba74;border-radius:8px;padding:5px 14px;font-size:12px;font-weight:600;color:#c2410c">↗ 새 창</a>
    </div>
    <iframe id="bsrFrame" title="BSR 대시보드"
      style="width:100%;height:calc(100vh - 170px);min-height:600px;border:1px solid #e2e8f0;border-radius:8px;background:#fff"></iframe>
    <div class="muted" style="font-size:11px;margin-top:6px">
      매주 화 14:30 자동 갱신 (내 PC 스케줄러) · ▶ 지금 분석으로 즉시 갱신. 실측·장부·포켓/쇼트·실측 비중·장부 적용 비중.</div>`;
  $('bsrReload').onclick = load;
  $('bsrRun').onclick = run;
}

// PC 가 sync→scan→build→publish (새 파일만 파싱). 게시 후 Pages 반영 1~2분.
function run() {
  toast('BSR 분석 시작 — PC 창에서 진행 확인, 끝나고 1~2분 뒤 🔄 새로고침');
  location.href = 'kmtcfolder:bsr-run';
}

async function load() {
  const t = Date.now();
  $('bsrFrame').src = `${URL}?t=${t}`;
  try {
    const r = await fetch(`${URL}?t=${t}`, { method: 'HEAD', cache: 'no-store' });
    const lm = r.headers.get('last-modified');
    $('bsrStamp').textContent = lm ? `게시: ${new Date(lm).toLocaleString('ko-KR')}` : '';
  } catch (e) {
    $('bsrStamp').textContent = '';
  }
}

function refresh() {
  if (!$('bsrFrame').src) load();
}

export default { id: 'bsr', mount, refresh };
