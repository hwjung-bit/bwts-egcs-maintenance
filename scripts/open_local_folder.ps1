# kmtcfolder:// protocol handler — opens a mapped local folder in Explorer.
# Registered under HKCU\Software\Classes\kmtcfolder (per-PC, see docs/DEPLOY.md).
# Web app buttons link to e.g. "kmtcfolder:bwtslog"; add new keys below as needed.
param([string]$Url = '')

$key = ($Url -replace '^kmtcfolder:/*', '').Trim('/').ToLower()

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
