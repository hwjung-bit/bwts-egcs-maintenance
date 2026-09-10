# Korean alarm for the monthly BWTS run. The .bat that calls this stays
# ASCII-only, so the Korean text lives here (UTF-8 with BOM).
param([string]$Period = "", [string]$ExitCode = "0")
$msg = "BWTS $Period 월간 로그 분석 완료 — 대시보드에서 미해결 건 확인"
if ($ExitCode -ne "0") {
  $msg = "BWTS $Period 월간 로그 분석 중단 (코드 $ExitCode) — 로그 확인"
}
$alarm = "C:\Users\user\.claude\claude_alarm.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $alarm $msg "BWTS"
