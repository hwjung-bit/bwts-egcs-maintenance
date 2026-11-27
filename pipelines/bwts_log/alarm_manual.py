"""Techcross ECS alarm code -> on-board action, taken from the maker manual.

Source: Techcross ECS OMSM TC1710-001-USCG(MD) Rev0.7, 7.2 "Trouble shooting for
ECS Major Alarm Message" (p.138~146) and 7.3 "Main Problems and Measures"
(p.147~168). Codes the manual does not list (valve group 721/727/731/774) fall
back to alarm_info.ALARM_INFO and are marked as not manual-backed.
Log descriptions decide the match where the HMI numbering differs from the
manual (ANU tank 301~303).
"""
from alarm_info import ALARM_INFO

REF = "Techcross ECS OMSM TC1710-001 Rev0.7"
# (code, desc keyword or None, name, actions, manual ref)
MAN = [
    ("200", None, "TRO 저농도",
     ["샘플링 밸브 외 다른 밸브가 닫혀 있는지 확인",
      "샘플수가 TRO 센서로 원활히 유입되는지 확인, too fast/slow 메시지가 뜨면 regulator 조정",
      "CLX 시약 유효기간(1개월) 확인, 경과 시 교체",
      "휴대용 측정기로 TRO 실측, 기준 미달이면 Techcross A/S 문의"], "7.2 p.138, 7.3.1.1 p.147~150"),
    ("201", None, "TRO 고농도",
     ["휴대용 측정기 실측값과 HMI 값 비교, HMI가 높으면 CLX 시약 교체 후 TSU 재시작",
      "디밸러스팅 중 발생이면 ANU 탱크 sodium thiosulfate 투입 여부, 샘플링 밸브 막힘, ANU 펌프 작동 확인",
      "지속되면 운전 중지 후 Techcross A/S 문의"], "7.2 p.138~139, 7.3.2.1 p.152"),
    ("220", None, "TRO 센서 샘플수 미유입",
     ["샘플수가 CLX cuvette로 유입되는지 확인", "TSU Sol. valve 전원 공급 확인",
      "Sol. valve 정상인데 유입이 안 되면 Y-strainer 점검"], "7.3.1.1 p.147~148"),
    ("240", "Purge", "TRO 센서 퍼지 막힘",
     ["APU 공기 공급 상태 확인", "배출라인 Y-strainer 분해 소제",
      "배출라인 막힘 시 각 포트 TSU Sol. valve 분해 점검", "APU diaphragm, O-ring 누설 확인"],
     "7.3.1.1 p.149~150"),
    ("240", None, "TRO 센서 통신 불량", ["TSU 전원, 통신 케이블 연결 확인"], "7.3.1.3 p.151"),
    ("202", None, "CLX 센서 전원 불량", ["CLX 센서 전원 공급 상태 확인"], "7.3.1.2 p.151"),
    (None, "Add Sodium", "중화제 투입 필요",
     ["매뉴얼 절차에 따라 ANU 탱크에 sodium thiosulfate 투입"], "7.2 p.139"),
    (None, "Tank Level Low", "ANU 탱크 저수위",
     ["급수 밸브 열림 확인", "급수 배관, Y-strainer 막힘 확인", "ANU 내부 solenoid valve 소제"],
     "7.2 p.139~140, 7.3.2.3 p.154"),
    (None, "Tank Level High", "ANU 탱크 고수위",
     ["ANU solenoid valve 완전 닫힘 확인, 이물질이 끼었으면 소제"], "7.2 p.140, 7.3.2.4 p.154"),
    ("406", None, "입력 전압 저하",
     ["PDE MCCB 차단 후 MSBD 공급 전압 확인", "전압 정상이면 ECS 절연저항 측정, 불량 시 Techcross A/S 문의"],
     "7.2 p.140"),
    ("604", None, "유량 저하",
     ["유량을 ECS 용량의 15% 이상으로 조정", "HMI 유량이 -20으로 표시되면 FMU 전원, 케이블 확인"], "7.2 p.141"),
    ("605", None, "유량 과다",
     ["유량을 ECS 용량의 110% 이하로 조정", "HMI 유량이 -20으로 표시되면 FMU 전원, 케이블 확인"], "7.2 p.141"),
    ("607", None, "염분 저하", ["CSU 표시값 확인", "저염분이면 mixing ballast 절차로 운전"], "7.2 p.142"),
    ("606", None, "H2 가스 검지",
     ["선내 H2 검지기로 실제 누설 여부 확인", "누설이 없는데 알람이면 GDS 전원, 케이블 확인"], "7.2 p.143"),
    ("400", None, "PDE 비상정지",
     ["PDE 비상정지 버튼 해제(시계 방향)", "지속되면 버튼 및 RTU 신호 케이블 확인"], "7.2 p.143"),
    ("100", None, "ECU 비상 상태",
     ["밸러스팅 중 발생이면 ECU 입구, 출구 원격밸브 열림 확인", "ECU 정비용 수동밸브 열림 확인",
      "비운전 중 발생이면 RCM 비상정지 버튼 확인",
      "압력스위치, 게이지 지시값과 케이블 연결 확인 후 Techcross 문의"], "7.2 p.144"),
    ("704", None, "Bypass 밸브 열림",
     ["VRCS 신호와 HMI 표시 일치 여부 확인, 불일치 시 케이블 확인"], "7.2 p.145"),
    ("603", None, "냉각 청수 고온",
     ["공급 청수 온도 38℃ 미만 확인", "청수 공급량 확인", "LT cooling pump 운전 확인",
      "FTS 및 PDE 간 케이블 확인"], "7.2 p.145, 7.3.5.1 p.163"),
    ("402", None, "440V Magnetic Contactor 불량",
     ["PDE 또는 MSBD MCCB 차단 후 contactor 단락, 케이블 체결 확인", "PDE 440V 라인 절연저항 확인",
      "contactor 불량이면 교체"], "7.2 p.145~146"),
    ("702", None, "GPS 통신 불량", ["GPS 신호 입력 및 케이블 확인"], "7.3.4.3 p.162"),
    ("701", None, "통신 불량",
     ["HUB와 각 모듈 간 전원, LAN 케이블 확인", "PLC와 각 모듈 간 RS-485 통신 케이블 확인",
      "PDE MCCB 투입 상태 확인"], "7.2 p.146"),
    ("703", None, "센서 통신 불량",
     ["PLC와 해당 센서 간 전원, 통신 케이블 확인", "PDE MCCB 투입 상태 확인"], "7.2 p.146, 7.3.3 p.156~160"),
    ("706", None, "EM'CY 모드",
     ["해당 패널 selector switch가 Emergency인지 확인, Remote로 전환"], "7.2 p.139"),
]


def manual(code, desc):
    """-> (name, [actions], ref, manual_backed)"""
    c = (code or "").replace("CODE", "")
    for mc, kw, name, acts, ref in MAN:
        if (mc is None or mc == c) and (kw is None or kw.lower() in (desc or "").lower()):
            return name, acts, f"OMSM {ref}", True
    a = ALARM_INFO.get(code)
    if a:
        return (a["title"].replace("[긴급] ", ""),
                [x.strip() for x in a["action"].split(". ") if x.strip()], "매뉴얼 7.2 미수록", False)
    return (desc or "")[:30], [], "매뉴얼 7.2 미수록", False
