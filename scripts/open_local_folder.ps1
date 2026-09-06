# kmtcfolder:// protocol handler - opens a mapped local folder in Explorer,
# or launches a local Claude Code task (this PC only).
# Registered under HKCU\Software\Classes\kmtcfolder (scripts/register_kmtcfolder.reg).
# Web app buttons link to e.g. "kmtcfolder:bwtslog" / "kmtcfolder:bwts-analysis"
# / "kmtcfolder:bwts-analysis?period=2026-08&ships=KCB,KSG".
# NOTE: keep this file UTF-8 WITH BOM - PS 5.1 reads BOM-less UTF-8 as ANSI
# and corrupts the Korean paths below.
#
# SECURITY: the URL comes from a web page, so every byte of it is untrusted and
# the values below end up on a command line. Two layers guard that:
#   1. reject the whole URL if it carries any shell/quote metacharacter - the
#      .reg passes "%1" verbatim, so a literal quote could split arguments
#      before this script ever runs;
#   2. allow-list each value AFTER percent-decoding. Anything that does not
#      match is dropped silently, never echoed back and never passed through.
# Only [A-Z0-9,-] and the literal words period/ships can reach the command line.
# Never add a $tasks entry whose prompt is built from free-form URL text.
param([string]$Url = '')

if ($Url.Length -gt 400 -or $Url -match '["`''$;|<>^()\r\n]') { exit }

$raw = $Url -replace '^kmtcfolder:/*', ''
$qs = ''
$i = $raw.IndexOf('?')
if ($i -ge 0) { $qs = $raw.Substring($i + 1); $raw = $raw.Substring(0, $i) }
$key = $raw.Trim('/').ToLower()      # lowercase the KEY only, never the values

function Get-QueryValue([string]$q, [string]$name) {
  foreach ($pair in ($q -split '&')) {
    $kv = $pair -split '=', 2
    if ($kv.Count -eq 2 -and $kv[0] -eq $name) {
      return [System.Uri]::UnescapeDataString($kv[1])   # decode, THEN validate
    }
  }
  return ''
}

$repo = 'D:\CLAUDE CODE\bwts-egcs-maintenance'

# Claude Code tasks: key -> initial prompt (opens a terminal in the repo)
$tasks = @{
  'bwts-analysis' = '/bwts-analysis'
  'bwts-review'   = '/bwts-review'
}
if ($tasks.ContainsKey($key)) {
  $prompt = $tasks[$key]
  $p = Get-QueryValue $qs 'period'
  $sh = (Get-QueryValue $qs 'ships').ToUpper()
  if ($p -match '^[0-9]{4}-(0[1-9]|1[0-2])\z') { $prompt += " period=$p" }
  if ($sh -match '^[A-Z]{3}(,[A-Z]{3}){0,23}\z') { $prompt += " ships=$sh" }
  Start-Process wt -ArgumentList @(
    '-d', "`"$repo`"", 'powershell', '-NoExit', '-Command',
    "claude `"$prompt`"")
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
