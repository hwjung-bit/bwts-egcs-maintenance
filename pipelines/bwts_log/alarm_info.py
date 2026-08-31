# alarm_info.py — BWTS Alarm Code Definitions
# Ported from alarmInfo.js (Techcross Manual v3.4)
import re

ALARM_CATEGORIES = {
    "TRO":    {"label": "TRO 이상",      "label_en": "TRO Issue",         "icon": "🔬"},
    "VALVE":  {"label": "밸브 이상",     "label_en": "Valve Issue",       "icon": "🔧"},
    "ECU":    {"label": "ECU/전원 이상", "label_en": "ECU/Power Issue",   "icon": "⚡"},
    "FLOW":   {"label": "유량 이상",     "label_en": "Flow Issue",        "icon": "💧"},
    "ANU":    {"label": "중화제 이상",   "label_en": "Neutralizer Issue", "icon": "🧪"},
    "COMM":   {"label": "통신 장애",     "label_en": "Communication",     "icon": "📡"},
    "ENV":    {"label": "환경/센서",     "label_en": "Environment",       "icon": "🌡️"},
    "SAFETY": {"label": "안전 경고",     "label_en": "Safety Alert",      "icon": "🚨"},
    "OTHER":  {"label": "기타",         "label_en": "Other",             "icon": "⚠️"},
}

VALVE_PATTERN = re.compile(r"Valve|밸브", re.IGNORECASE)
VALVE_CODES = re.compile(r"^7(?:0[4]|[2-3]\d|7[4])$")

ALARM_INFO = {
    "CODE100": {
        "cat": "ECU",
        "title": "ECU 비상정지",
        "title_en": "ECU Emergency Stop",
        "action": "ECU 내부 점검 — 전류 과부하(>PRU×1125A), "
                  "고압(>4.5bar), 고온(>45°C), VLS 에러 가능성. "
                  "PRU 상태 및 전극 확인",
        "action_en": "Inspect ECU — overcurrent(>PRU×1125A), "
                     "high pressure(>4.5bar), high temp(>45°C), "
                     "or VLS error. Check PRU and electrode status",
    },
    "CODE200": {
        "cat": "TRO",
        "title": "TRO 저농도",
        "title_en": "TRO Concentration Low",
        "action": "Ballast 중 TRO <5mg/L (3회 연속 시 발생). "
                  "CLX 시약 유효기간 및 TSU Bypass Line 소통 상태 점검",
        "action_en": "TRO <5mg/L during ballasting "
                     "(triggered after 3 consecutive readings). "
                     "Check CLX reagent date and TSU bypass line",
    },
    "CODE201": {
        "cat": "TRO",
        "title": "TRO 고농도",
        "title_en": "TRO Concentration High",
        "action": "Ballast >10mg/L 또는 "
                  "Deballast >0.1mg/L(IMO)/>0.07mg/L(USCG). "
                  "STS 주입 펌프 및 ANU 탱크 레벨 확인",
        "action_en": "Ballast >10mg/L or "
                     "Deballast >0.1mg/L(IMO)/>0.07mg/L(USCG). "
                     "Check STS pump and ANU tank level",
    },
    "CODE301": {
        "cat": "ANU",
        "title": "중화제 탱크 초기충전",
        "title_en": "ANU Tank Initial Fill",
        "action": "중화제(NaCl) 초기 충전 필요. "
                  "레벨 센서 영점 교정 및 탱크 상태 확인",
        "action_en": "Neutralizer(NaCl) initial fill required. "
                     "Recalibrate level sensor and check tank condition",
    },
    "CODE302": {
        "cat": "ANU",
        "title": "중화제 탱크 저수위",
        "title_en": "ANU Tank Level Low",
        "action": "중화제 보충 필요. 레벨 센서 및 공급 라인 밸브 점검",
        "action_en": "Replenish neutralizer. "
                     "Check level sensor and supply line valves",
    },
    "CODE303": {
        "cat": "ANU",
        "title": "중화제 탱크 고수위",
        "title_en": "ANU Tank Level High",
        "action": "오버플로우 방지 밸브 및 배출 라인 점검. "
                  "레벨 센서 고착 여부 확인",
        "action_en": "Check overflow prevention valve and drain line. "
                     "Inspect level sensor for stuck condition",
    },
    "CODE400": {
        "cat": "ECU",
        "title": "PDE 비상정지",
        "title_en": "PDE Emergency Stop",
        "action": "운전자에 의한 긴급 정지. "
                  "PDE 상태 확인 후 원인 조치 및 리셋",
        "action_en": "Emergency stop by operator. "
                     "Check PDE status, address root cause and reset",
    },
    "CODE402": {
        "cat": "ECU",
        "title": "440V MC 투입 실패",
        "title_en": "440V MC Fail",
        "action": "전자접촉기(MC) 고장. 전원 공급 상태, "
                  "MC 코일/접점, MCCB 트립 여부 점검",
        "action_en": "Magnet contactor malfunction. "
                     "Check power supply, MC coil/contacts, MCCB trip",
    },
    "CODE405": {
        "cat": "ECU",
        "title": "ECU 전류 과부하",
        "title_en": "ECU Current High",
        "action": "전류 >PRU×1125A. 전극 스케일 부착 또는 "
                  "해수 염분 급변 가능성. CIP 세정 및 CSU 센서 확인",
        "action_en": "Current >PRU×1125A. Possible electrode scaling "
                     "or salinity change. Perform CIP and check CSU",
    },
    "CODE406": {
        "cat": "ECU",
        "title": "입력 전압 저하",
        "title_en": "Input Voltage Low",
        "action": "입력 전압 <374V(440V-15%) Alarm, "
                  "<352V(440V-20%) Fault. 배전반 전압 및 발전기 AVR 점검",
        "action_en": "Input voltage <374V(-15%) Alarm, "
                     "<352V(-20%) Fault. Check switchboard voltage "
                     "and generator AVR",
    },
    "CODE407": {
        "cat": "ECU",
        "title": "입력 전압 과다",
        "title_en": "Input Voltage High",
        "action": "입력 전압 >506V(440V+15%) Alarm, "
                  ">528V(440V+20%) Fault. 배전반 전압 및 발전기 AVR 점검",
        "action_en": "Input voltage >506V(+15%) Alarm, "
                     ">528V(+20%) Fault. Check switchboard voltage "
                     "and generator AVR",
    },
    "CODE503": {
        "cat": "FLOW",
        "title": "펌프 신호 미확인",
        "title_en": "Pump Signal Not Confirmed",
        "action": "해수/담수 펌프 운전 신호 미수신. "
                  "1분 지속 시 Shutdown. 펌프 기동 상태 및 신호 배선 점검",
        "action_en": "S.W/F.W pump signal not confirmed. "
                     "Shutdown after 1 min. Check pump start status "
                     "and signal wiring",
    },
    "CODE600": {
        "cat": "ENV",
        "title": "해수 온도 저온",
        "title_en": "Seawater Temp Low",
        "action": "저온 해역 운항 시 정상 발생 가능. "
                  "히터 작동 여부 확인. 지속 시 운전 모드 조정",
        "action_en": "May be normal in cold water areas. "
                     "Check heater operation. "
                     "Adjust operating mode if persistent",
    },
    "CODE601": {
        "cat": "ENV",
        "title": "해수 온도 과열",
        "title_en": "Seawater Temp High",
        "action": "해수 온도 >36°C. 해수 흡입 라인 및 온도 센서 점검. "
                  "고온 해역 운항 시 정상 발생 가능",
        "action_en": "Seawater temp >36°C. Check seawater intake line "
                     "and temp sensor. May be normal in warm waters",
    },
    "CODE603": {
        "cat": "ENV",
        "title": "냉각수 온도 과열",
        "title_en": "Cooling Water Temp High",
        "action": "냉각수 >43°C Alarm, >45°C Fault. "
                  "냉각수 펌프, 열교환기 오염, 냉각수 라인 밸브 점검",
        "action_en": "Cooling water >43°C Alarm, >45°C Fault. "
                     "Check cooling pump, heat exchanger fouling, "
                     "line valves",
    },
    "CODE604": {
        "cat": "FLOW",
        "title": "유량 저하",
        "title_en": "FMU Flow Rate Low",
        "action": "유량 <15% (3분 지속 Alarm, 5분 Fault). "
                  "해수 펌프, 스트레이너 막힘, 흡입 밸브 점검",
        "action_en": "Flow rate <15% (3min Alarm, 5min Fault). "
                     "Check seawater pump, strainer blockage, "
                     "suction valve",
    },
    "CODE605": {
        "cat": "FLOW",
        "title": "유량 과다",
        "title_en": "FMU Flow Rate High",
        "action": "유량 >110% (저염분 Mixing 시 >80%). "
                  "3분 지속 Alarm, 5분 Fault. "
                  "유량 조절 밸브 및 FMU 센서 점검",
        "action_en": "Flow rate >110% (Mixing >80%). "
                     "3min Alarm, 5min Fault. "
                     "Check flow control valve and FMU calibration",
    },
    "CODE606": {
        "cat": "SAFETY",
        "title": "수소가스 감지",
        "title_en": "H2 Gas Detected",
        "action": ">25%LEL Alarm, >50%LEL Fault(Shutdown). "
                  "전해조 가스 누출 점검. 환기 팬 작동 확인",
        "action_en": ">25%LEL Alarm, >50%LEL Fault(Shutdown). "
                     "Check electrolyzer gas leak. "
                     "Verify ventilation fan operation",
    },
    "CODE607": {
        "cat": "ENV",
        "title": "저염분 감지",
        "title_en": "CSU Conductivity Low",
        "action": "염분 <1.0PSU (1분 지속 Alarm, 2분 Fault). "
                  "저염분 해역 운항 시 처리 효율 저하. CSU 센서 점검",
        "action_en": "Salinity <1.0PSU (1min Alarm, 2min Fault). "
                     "Low efficiency in low-salinity waters. "
                     "Check CSU sensor",
    },
    "CODE701": {
        "cat": "COMM",
        "title": "통신 장애",
        "title_en": "Communication Fail",
        "action": "ECS 장비 간 통신 두절. 1분 지속 시 Shutdown. "
                  "RTU/AIM 모듈 케이블 및 커넥터 점검",
        "action_en": "Communication failure between ECS devices. "
                     "Shutdown after 1min. "
                     "Check RTU/AIM cables and connectors",
    },
    "CODE703": {
        "cat": "COMM",
        "title": "센서 통신 에러",
        "title_en": "Sensor Communication Error",
        "action": "해당 센서 배선 및 커넥터 점검. "
                  "센서 모듈 교체 필요 여부 확인",
        "action_en": "Check sensor wiring and connectors. "
                     "Assess module replacement need",
    },
    "CODE704": {
        "cat": "VALVE",
        "title": "Bypass 밸브 개방",
        "title_en": "Bypass Valve Opened",
        "action": "Ballast 운전 중 Bypass 밸브 개방. "
                  "미처리수 유입 가능. 밸브 리미트 스위치 및 공압 라인 점검",
        "action_en": "Bypass valve opened during ballasting. "
                     "Untreated water may flow. "
                     "Check limit switch and pneumatic line",
    },
    "CODE706": {
        "cat": "ECU",
        "title": "비상운전 모드 진입",
        "title_en": "Emergency Mode",
        "action": "자동 운전 불가 상태. "
                  "RCM 셀렉트 스위치 변경 또는 원인 알람 확인 후 리셋",
        "action_en": "Auto operation unavailable. "
                     "Check RCM select switch or root cause alarm, "
                     "then reset",
    },
    "CODE721": {
        "cat": "VALVE",
        "title": "밸브 작동 이상",
        "title_en": "Valve Operation Error",
        "action": "밸브 공압 실린더, 리미트 스위치, 솔레노이드 밸브 점검",
        "action_en": "Check valve pneumatic cylinder, "
                     "limit switch, solenoid valve",
    },
    "CODE727": {
        "cat": "SAFETY",
        "title": "[긴급] 미처리수 배출",
        "title_en": "[URGENT] Untreated Water Discharge",
        "action": "IMO 규정 위반 가능성. "
                  "즉시 운전 중지 후 밸브 라인업 및 TRO 센서 확인",
        "action_en": "Possible IMO violation. "
                     "Stop operation immediately "
                     "and check valve lineup and TRO sensor",
    },
    "CODE731": {
        "cat": "VALVE",
        "title": "밸브 비정상 종료",
        "title_en": "Valve Abnormal Stop",
        "action": "밸브 작동 중 ECS 비정상 종료. "
                  "밸브 현재 위치 확인 후 수동 리셋",
        "action_en": "ECS shut down during valve operation. "
                     "Verify valve position and manual reset",
    },
    "CODE734": {
        "cat": "SAFETY",
        "title": "탄화수소 가스 감지",
        "title_en": "Hydrocarbon Gas Detected",
        "action": "탄화수소 가스 감지 — 즉시 Fault(Shutdown). "
                  "가스 누출원 확인 및 환기 점검",
        "action_en": "Hydrocarbon gas detected — "
                     "immediate Fault(Shutdown). "
                     "Check gas leak source and ventilation",
    },
    "CODE774": {
        "cat": "VALVE",
        "title": "냉각수 밸브 이상",
        "title_en": "Cooling Water Valve Error",
        "action": "냉각수 공급 밸브(F.W Inlet) "
                  "리미트 스위치 및 공압 점검. 에어 벤트 확인",
        "action_en": "Check F.W inlet valve limit switch "
                     "and pneumatic line. Vent air from cooling line",
    },
    "VRCS_ERR": {
        "cat": "VALVE",
        "title": "[긴급] 밸브 채터링",
        "title_en": "[URGENT] Valve Chattering",
        "action": "밸브 반복 개폐 감지. "
                  "공압 라인 누기, 리미트 스위치, 솔레노이드 밸브 즉각 점검",
        "action_en": "Repeated valve open/close detected. "
                     "Immediately inspect pneumatic line, "
                     "limit switch, solenoid valve",
    },
    "LOG_OVERFLOW": {
        "cat": "OTHER",
        "title": "Event Log 과다",
        "title_en": "Event Log Overflow",
        "action": "Event Log 100건 초과. "
                  "반복 알람 원인 분석 및 전체 로그 상세 검토 필요",
        "action_en": "Event Log exceeded 100 entries. "
                     "Analyze repeated alarm root cause "
                     "and perform detailed log review",
    },
}
