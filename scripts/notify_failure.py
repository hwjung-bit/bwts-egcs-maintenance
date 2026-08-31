"""
워크플로 실패 알림 — GitHub Actions 전용

2026-08 사고: Gmail 토큰이 만료돼 collect 가 2시간마다 이틀간 실패했는데
아무도 몰랐다. 실패를 사람에게 도달시키는 게 이 스크립트의 유일한 일이다.

각 워크플로 마지막에 `if: failure()` 스텝으로 붙인다.

의존성 없음 (stdlib only). pip install 단계 자체가 실패한 경우에도
알림은 나가야 하므로 supabase / google 라이브러리를 쓰지 않는다.

필요한 환경변수:
  GMAIL_USER, GMAIL_APP_PASSWORD   기존 시크릿 그대로
  WF_NAME, RUN_URL                 워크플로에서 주입
  ALERT_TO                         (선택) 기본값 GMAIL_USER
"""

import os
import smtplib
import sys
from email.message import EmailMessage


def main():
    user = os.environ.get("GMAIL_USER", "")
    pw = os.environ.get("GMAIL_APP_PASSWORD", "")
    if not user or not pw:
        print("GMAIL_USER / GMAIL_APP_PASSWORD 미설정 — 알림 생략", file=sys.stderr)
        return 1

    wf = os.environ.get("WF_NAME", "(unknown workflow)")
    url = os.environ.get("RUN_URL", "")
    to = os.environ.get("ALERT_TO") or user

    msg = EmailMessage()
    msg["Subject"] = f"[BWTS/EGCS 실패] {wf}"
    msg["From"] = user
    msg["To"] = to
    msg.set_content(
        f"자동화 워크플로가 실패했습니다.\n\n"
        f"  워크플로 : {wf}\n"
        f"  실행 로그 : {url}\n\n"
        f"자주 나오는 원인:\n"
        f"  - invalid_grant / RefreshError\n"
        f"    → Gmail OAuth 토큰 만료. scripts/make_token.py 로 재발급 후\n"
        f"      GMAIL_TOKEN_JSON 과 DRIVE_TOKEN_JSON 시크릿을 함께 갱신.\n"
        f"  - Supabase 조회 0건\n"
        f"    → 서비스 키 만료 또는 RLS 변경 여부 확인.\n"
    )

    # 알림 자체가 매달리면 잡이 6시간 타임아웃까지 살아 있으므로 timeout 필수.
    for attempt in (1, 2):
        try:
            with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
                s.login(user, pw)
                s.send_message(msg)
            print(f"실패 알림 발송: {to}")
            return 0
        except Exception as e:  # noqa: BLE001 — 알림 실패로 잡을 더 망치지 않는다
            print(f"알림 발송 실패 (시도 {attempt}/2): {e}", file=sys.stderr)

    return 1


if __name__ == "__main__":
    sys.exit(main())
