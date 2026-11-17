# Rebuild every derived index from data/favs.json (no downloads, no API calls).
# Usage: powershell -ExecutionPolicy Bypass -File scripts\rebuild.ps1
# Keep this file ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($name, $script, $arg) {
    Write-Host ""
    Write-Host "== $name" -ForegroundColor Cyan
    & node $script $arg
    if ($LASTEXITCODE -ne 0) { throw "$name failed" }
}

Step "catalog"     "cli\catalog.mjs" "build"
Step "topics"      "cli\topics.mjs"  "build"
Step "topic pages" "cli\moc.mjs"     ""
Step "note index"  "cli\note.mjs"    "index"

Write-Host ""
Write-Host "done. see vault/00-index" -ForegroundColor Green
