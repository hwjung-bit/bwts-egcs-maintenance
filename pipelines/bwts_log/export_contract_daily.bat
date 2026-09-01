@echo off
rem Daily export of the dashboard contract (G-drive JSON + legacy env_snapshot.json)
rem from Supabase. Registered in Windows Task Scheduler as "BWTS_EGCS_ExportContract".
rem Needs user env vars SUPABASE_URL / SUPABASE_SERVICE_KEY.
cd /d "%~dp0"
set PYTHONIOENCODING=utf-8
python export_contract.py >> "%~dp0out\export_contract_daily.log" 2>&1
