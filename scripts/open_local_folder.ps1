# kmtcfolder:// protocol handler — opens a mapped local folder in Explorer,
# or launches a local Claude Code task (this PC only).
# Registered under HKCU\Software\Classes\kmtcfolder (scripts/register_kmtcfolder.reg).
# Web app buttons link to e.g. "kmtcfolder:bwtslog" / "kmtcfolder:bwts-analysis".
# NOTE: keep this file UTF-8 WITH BOM — PS 5.1 reads BOM-less UTF-8 as ANSI
# and corrupts the Korean paths below.
param([string]$Url = '')

$key = ($Url -replace '^kmtcfolder:/*', '').Trim('/').ToLower()

$repo = 'D:\CLAUDE CODE\bwts-egcs-maintenance'

# Claude Code tasks: key → initial prompt (opens a terminal in the repo)
$tasks = @{
  'bwts-analysis' = '/bwts-analysis'
  'bwts-review'   = '/bwts-review'
}
if ($tasks.ContainsKey($key)) {
  Start-Process wt -ArgumentList @(
    '-d', "`"$repo`"", 'powershell', '-NoExit', '-Command',
    "claude `"$($tasks[$key])`"")
  exit
}

$map = @{
  'bwtslog' = 'G:\공유 드라이브\고려에스엠 0033 공무팀 환경기술파트\011  BWTS\4. BWTS LOG DATA'
}

$path = $map[$key]
if ($path -and (Test-Path $path)) {
  Start-Process explorer.exe -ArgumentList "`"$path`""
} else {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show(
    "폴더를 찾을 수 없습니다.`nkey: $key`npath: $path",
    'kmtcfolder') | Out-Null
}
