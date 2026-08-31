# fleet_mail.py — Mail draft generation for missing BWTS data
from config import VESSEL_BY_CODE


def generate_mail_drafts(all_summaries):
    """
    Generate mail drafts for vessels with missing/bad data.
    Groups by vessel across months.
    Returns list of {vessel_code, vessel_name, subject, body,
                     issue_months}.
    """
    vessel_issues = {}
    for s in all_summaries:
        if s["grade"] in ("미수신", "데이터불량"):
            code = s["code"]
            vessel_issues.setdefault(code, []).append({
                "year": s["year"],
                "month": s["month"],
                "grade": s["grade"],
                "detail": s.get("reception_detail", ""),
            })

    drafts = []
    for code, issues in sorted(vessel_issues.items()):
        vessel = VESSEL_BY_CODE.get(code, {})
        name = vessel.get("name", code)

        months_lines = []
        for iss in sorted(issues, key=lambda x: (
                x["year"], x["month"])):
            months_lines.append(
                f"  - {iss['year']}년 {iss['month']}월: "
                f"{iss['detail']}")

        months_str = "\n".join(months_lines)

        subject = f"[BWTS LOG 재전송 요청] {name}"
        body = (
            f"안녕하세요, 고려에스엠 환경기술파트입니다.\n\n"
            f"{name}호의 아래 기간 BWTS LOG 데이터가 "
            f"정상 수신되지 않았습니다.\n"
            f"확인 후 재전송 부탁드립니다.\n\n"
            f"■ 미수신/불량 기간:\n"
            f"{months_str}\n\n"
            f"■ 필요 파일 (3종):\n"
            f"  1. OPERATIONTIMELOG.CSV\n"
            f"  2. DATALOG.CSV (또는 DATAREPORTLOG.CSV)\n"
            f"  3. EVENTLOG.CSV\n\n"
            f"■ 전송 방법:\n"
            f"  - 기존과 동일하게 이메일 전송\n"
            f"  - ZIP 압축 시 암호 설정하지 말 것\n"
            f"  - 파일명에 선박명/월 포함 권장\n\n"
            f"감사합니다.\n"
            f"고려에스엠 공무팀 환경기술파트"
        )

        drafts.append({
            "vessel_code": code,
            "vessel_name": name,
            "subject": subject,
            "body": body,
            "issue_months": [
                (i["year"], i["month"]) for i in issues],
            "issue_count": len(issues),
        })

    return drafts
