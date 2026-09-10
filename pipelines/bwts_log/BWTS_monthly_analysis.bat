@echo off
rem Monthly BWTS log analysis via Claude Code.
rem Scheduled task "BWTS_LogAnalysisMonthly", day 10 of each month.
rem Analyzes the LAST COMPLETED month only, then runs the review loop.
rem
rem Must run in the interactive user session:
rem   - G: is a mapped drive that only exists when the user is logged on
rem   - SUPABASE_URL / SUPABASE_SERVICE_KEY live in HKCU\Environment
rem A SYSTEM task would read every vessel as "not received" and could
rem publish a fleet of false grades.
setlocal
cd /d "D:\CLAUDE CODE\bwts-egcs-maintenance"
set PYTHONIOENCODING=utf-8
for /f %%i in ('powershell -NoProfile -Command "(Get-Date).AddMonths(-1).ToString('yyyy-MM')"') do set P=%%i
if not exist "pipelines\bwts_log\out" mkdir "pipelines\bwts_log\out"
set LOG=pipelines\bwts_log\out\monthly_%P%.log
echo ==== %DATE% %TIME% period=%P% >> "%LOG%"
claude "/bwts-analysis period=%P% auto=monthly" >> "%LOG%" 2>&1
echo exit code %ERRORLEVEL% >> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0monthly_alarm.ps1" "%P%" "%ERRORLEVEL%"
endlocal
