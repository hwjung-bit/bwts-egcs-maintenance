@echo off
rem BWTS daily watch (관제) - scheduled task "BWTS_DailyWatch", weekdays 09:30.
rem Must run in the interactive user session (G: mapping, HKCU env vars),
rem same as BWTS_monthly_analysis.bat.
setlocal
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('SUPABASE_URL','User')"`) do set SUPABASE_URL=%%i
for /f "usebackq delims=" %%i in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('SUPABASE_SERVICE_KEY','User')"`) do set SUPABASE_SERVICE_KEY=%%i
if not exist "out" mkdir "out"
echo ==== %DATE% %TIME% >> "out\daily_watch.log"
python -X utf8 watch.py >> "out\daily_watch.log" 2>&1
echo exit code %ERRORLEVEL% >> "out\daily_watch.log"
endlocal
