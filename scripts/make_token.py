"""
OAuth 토큰 발급기 — gmail.readonly + drive.readonly

Drive 폴더 색인(drive_index.py)은 drive.readonly 스코프가 필요하다.
기존 GMAIL_TOKEN_JSON은 gmail 전용이라 한 번 재발급해야 한다.

사용법 (로컬 PC, 브라우저 있는 환경):
  1) Google Cloud Console에서 이 프로젝트의 OAuth 클라이언트
     (데스크톱 앱) JSON을 내려받아 client_secret.json 으로 저장
     — Drive API도 '사용 설정' 되어 있어야 한다
  2) pip install google-auth-oauthlib
  3) python scripts/make_token.py client_secret.json
  4) 브라우저 동의 후 출력된 JSON 한 줄을 GitHub 시크릿
     GMAIL_TOKEN_JSON 에 붙여넣기 (또는 DRIVE_TOKEN_JSON 신규 등록)

출력 JSON은 collector / indexer가 모두 읽는 형식이다.
"""

import json, sys

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
]


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    flow = InstalledAppFlow.from_client_secrets_file(
        sys.argv[1], SCOPES)
    creds = flow.run_local_server(port=0)

    out = {
        "access_token": creds.token,
        "refresh_token": creds.refresh_token,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes or SCOPES),
    }
    print()
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
