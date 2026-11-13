"""Chain the 공무팀 Dash env-contract-2 export (sql/039 views + CII + REG + costs)
after export_contract.py in the same daily task (BWTS_EGCS_ExportContract 07:30).

The export script lives in the dashboard project folder; a .bat cannot hold that
Korean absolute path safely, so the batch file calls this ASCII-named launcher.
"""
import runpy
import sys
from pathlib import Path

SCRIPT = Path(r"D:\CLAUDE CODE\공무팀 대시보드 환경파트\export\export_env2.py")
sys.argv = [str(SCRIPT)]
runpy.run_path(str(SCRIPT), run_name="__main__")
