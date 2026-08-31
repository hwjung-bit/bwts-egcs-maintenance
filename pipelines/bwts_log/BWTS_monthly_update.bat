@echo off
rem BWTS log pipeline: analyze current year (up to last month) -> publish to Supabase.
rem Requires user env vars SUPABASE_URL and SUPABASE_SERVICE_KEY.
rem Usage: BWTS_monthly_update.bat            (2026-01 ~ last month)
rem        BWTS_monthly_update.bat 2024-2026  (multi-year backfill)
cd /d "%~dp0"
if "%~1"=="" (
  python run.py -v
) else (
  python run.py --years %~1 -v
)
echo.
echo exit code %ERRORLEVEL%
pause
