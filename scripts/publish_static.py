"""정적 자료(IMO 통합본, BSR 대시보드)를 Pages 리포 archive/ 에 복사하고 바뀐 것만 push.

📎 자료 탭이 archive/imo/, archive/bsr/ 를 정적 주소로 연다. GAS 업무관리대장의
?doc= 렌더(드라이브 HTML)를 대신하는 경로. BSR 은 대시보드_갱신_무인.bat 가 빌드 뒤에
이 스크립트를 부르고, IMO 는 코워크가 통합본을 갱신한 뒤(또는 수동으로) 부른다.

사용자 PC 에서만 의미 있다 (G:/D: 경로 + git push 권한). 바뀐 파일이 없으면 아무것도 안 한다.
"""
import pathlib
import subprocess
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SOURCES = {
    "archive/imo/index.html": pathlib.Path(
        r"G:\공유 드라이브\고려에스엠 0033 공무팀 환경기술파트\002  협약 및 기술 자료"
        r"\004  IMO 규제 동향\IMO소식_국제해사동향\IMO소식_국제해사동향_통합.html"),
    "archive/bsr/index.html": pathlib.Path(
        r"D:\CLAUDE CODE\(제작중) 본선 BUNKER SOUNDING 분석\BSR_DASHBOARD\index.html"),
}


def main():
    changed = []
    for rel, src in SOURCES.items():
        if not src.exists():
            print("skip (source missing):", src)
            continue
        data = src.read_bytes()          # G: 는 스트리밍 마운트 — 통째로 읽는다
        dst = REPO / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists() and dst.read_bytes() == data:
            print("unchanged:", rel)
            continue
        dst.write_bytes(data)
        changed.append(rel)
        print(f"updated: {rel} ({len(data):,} bytes)")
    if not changed:
        return 0
    git = lambda *a: subprocess.run(["git", "-C", str(REPO), *a], check=True)
    git("add", *changed)
    git("commit", "-q", "-m", "chore(archive): 정적 자료 갱신 — " + ", ".join(changed))
    git("push", "-q", "origin", "main")
    print("pushed:", ", ".join(changed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
