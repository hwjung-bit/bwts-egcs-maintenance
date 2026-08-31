"""
수집 정체 감시 — 하루 1회

실패 알림(notify_failure.py)은 잡이 "실패했을 때"만 울린다.
잡이 아예 실행되지 않으면 실패도 발생하지 않으므로 아무도 모른다:

  - GitHub 은 커밋 없는 리포의 스케줄 워크플로를 60일 후 자동 비활성화한다
  - 스케줄 자체가 밀리거나 누락되는 경우도 있다
  - 잡이 중간에 killed 되면(타임아웃, 러너 장애) 스텝이 안 돌 수 있다

그래서 "수집기가 마지막으로 끝까지 돈 시각"을 별도로 확인한다.
supabase_collector.py 가 성공할 때마다 config['last_collect_ok'] 에
UTC ISO 시각을 남기고, 이 스크립트가 그 나이를 본다.

"새 메일 0건"을 신호로 쓰지 않는 이유: 밤과 주말에는 정상이다.

주의 — 이 스크립트도 같은 리포의 Actions 에서 돈다. 60일 자동
비활성화가 걸리면 이것도 함께 멈춘다. 그 경우는 GitHub 이 소유자에게
보내는 사전 경고 메일에 의존한다. 완전한 방어는 리포 밖의 감시가 필요하다.

필요한 환경변수:
  SUPABASE_URL, SUPABASE_SERVICE_KEY
  GMAIL_USER, GMAIL_APP_PASSWORD   경보 발송용
  MAX_AGE_HOURS                    (선택) 기본 6
"""

import os
import smtplib
import sys
from datetime import datetime, timezone
from email.message import EmailMessage

from supabase import create_client

REPO_URL = "https://github.com/hwjung-bit/bwts-egcs-maintenance/actions"


def alert(subject, body):
    user = os.environ.get("GMAIL_USER", "")
    pw = os.environ.get("GMAIL_APP_PASSWORD", "")
    if not user or not pw:
        print("GMAIL_USER / GMAIL_APP_PASSWORD 미설정 — 경보 생략",
              file=sys.stderr)
        return
    msg = EmailMessage()
    msg["Subject"] = subject
    msg["From"] = user
    msg["To"] = os.environ.get("ALERT_TO") or user
    msg.set_content(body)
    try:
        with smtplib.SMTP_SSL("smtp.gmail.com", 465, timeout=30) as s:
            s.login(user, pw)
            s.send_message(msg)
        print("경보 발송 완료")
    except Exception as e:  # noqa: BLE001
        print(f"경보 발송 실패: {e}", file=sys.stderr)


def main():
    url = os.environ.get("SUPABASE_URL", "")
    key = os.environ.get("SUPABASE_SERVICE_KEY", "")
    if not url or not key:
        print("SUPABASE_URL/SERVICE_KEY not set", file=sys.stderr)
        return 1

    max_age = float(os.environ.get("MAX_AGE_HOURS", "6"))
    sb = create_client(url, key)

    res = sb.table("config").select("value").eq(
        "key", "last_collect_ok").execute()
    rows = res.data or []

    if not rows:
        alert(
            "[BWTS/EGCS] 수집 하트비트 없음",
            "config['last_collect_ok'] 가 비어 있습니다.\n\n"
            "수집기가 이 값을 남기기 시작한 뒤로 한 번도 성공하지 못했거나,\n"
            "config 테이블 접근이 막혔습니다.\n\n"
            f"실행 이력: {REPO_URL}\n",
        )
        print("하트비트 행 없음")
        return 1

    last = datetime.fromisoformat(rows[0]["value"])
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    age_h = (datetime.now(timezone.utc) - last).total_seconds() / 3600

    if age_h > max_age:
        alert(
            "[BWTS/EGCS] 메일 수집이 멈췄습니다",
            f"수집기가 마지막으로 성공한 지 {age_h:.1f}시간 지났습니다.\n"
            f"(2시간마다 실행되므로 {max_age:.0f}시간을 넘으면 비정상)\n\n"
            f"  마지막 성공 : {last.isoformat()}\n"
            f"  실행 이력   : {REPO_URL}\n\n"
            "확인할 것:\n"
            "  - Actions 탭에서 Mail Collect 가 실행되고 있는지\n"
            "  - 스케줄 워크플로가 자동 비활성화되지 않았는지\n"
            "    (커밋 없이 60일 지나면 GitHub 이 끈다)\n",
        )
        print(f"수집 정체: {age_h:.1f}시간 (허용 {max_age:.0f})")
        return 1

    print(f"정상: 마지막 수집 성공 {age_h:.1f}시간 전")
    return 0


if __name__ == "__main__":
    sys.exit(main())
