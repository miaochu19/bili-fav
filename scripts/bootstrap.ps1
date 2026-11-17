# 依赖引导：yt-dlp（Python 模块 + cmd 垫片）与 ffmpeg 装进项目内，不碰系统 PATH。
# 用法：powershell -ExecutionPolicy Bypass -File scripts\bootstrap.ps1
$ErrorActionPreference = "Stop"
# 非交互 shell 里 Write-Progress 会去读控制台缓冲区并报 "Access is denied"
$ProgressPreference = "SilentlyContinue"

$root   = Split-Path -Parent $PSScriptRoot
$tools  = Join-Path $root "tools"
$vendor = Join-Path $root "vendor"
$tmp    = Join-Path $root "data\tmp"
$fetch  = Join-Path $PSScriptRoot "fetch.mjs"

$env:TEMP = $tmp
$env:TMP  = $tmp

foreach ($d in @($tools, $vendor, (Join-Path $root "data"), (Join-Path $root "data\cache"), (Join-Path $root "data\logs"), $tmp, (Join-Path $root "vault"))) {
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }

# ---------- yt-dlp ----------
# 说明：官方 yt-dlp.exe 是 PyInstaller 打包的，在本机会话的沙箱里解压临时目录失败
#       （"Failed to create parent directory structure"）。改用源码 + `python -m yt_dlp`。
Step "yt-dlp (python module)"
$pylibs = Join-Path $tools "pylibs"
$ytdlpSrc = Join-Path $pylibs "yt-dlp-master"
$shim = Join-Path $tools "yt-dlp.cmd"

if (Test-Path (Join-Path $ytdlpSrc "yt_dlp\__init__.py")) {
    Write-Host "already present, skip download"
} else {
    New-Item -ItemType Directory -Force -Path $pylibs | Out-Null
    $tgz = Join-Path $tmp "ytdlp.tgz"
    if (-not (Test-Path $tgz)) {
        node $fetch "https://github.com/yt-dlp/yt-dlp/archive/refs/heads/master.tar.gz" $tgz
        if ($LASTEXITCODE -ne 0) { throw "yt-dlp download failed" }
    }
    tar -xzf $tgz -C $pylibs
    if ($LASTEXITCODE -ne 0) { throw "yt-dlp extract failed" }
}

if (-not (Test-Path $shim)) {
    @"
@echo off
setlocal
set "PYTHONPATH=%~dp0pylibs\yt-dlp-master"
python -m yt_dlp %*
"@ | Set-Content -Path $shim -Encoding ascii
}

& $shim --version
if ($LASTEXITCODE -ne 0) { throw "yt-dlp not runnable" }

# 清掉之前下载失败的 PyInstaller 版本
$brokenExe = Join-Path $tools "yt-dlp.exe"
if (Test-Path $brokenExe) { Remove-Item $brokenExe -Force }

# ---------- ffmpeg ----------
Step "ffmpeg"
$ffmpeg  = Join-Path $tools "ffmpeg.exe"
$ffprobe = Join-Path $tools "ffprobe.exe"
if ((Test-Path $ffmpeg) -and (Test-Path $ffprobe)) {
    Write-Host "already exists, skip download"
} else {
    $zip = Join-Path $tmp "ffmpeg-essentials.zip"
    if (-not (Test-Path $zip)) {
        node $fetch "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" $zip
        if ($LASTEXITCODE -ne 0) { throw "ffmpeg download failed" }
    }
    $outDir = Join-Path $tmp "ffmpeg-extract"
    if (Test-Path $outDir) { Remove-Item $outDir -Recurse -Force }
    Expand-Archive -Path $zip -DestinationPath $outDir -Force
    $srcFfmpeg  = Get-ChildItem $outDir -Recurse -Filter "ffmpeg.exe"  | Select-Object -First 1
    $srcFfprobe = Get-ChildItem $outDir -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
    if (-not $srcFfmpeg) { throw "ffmpeg.exe not found in archive" }
    Copy-Item $srcFfmpeg.FullName $ffmpeg -Force
    if ($srcFfprobe) { Copy-Item $srcFfprobe.FullName $ffprobe -Force }
}
& $ffmpeg -hide_banner -version | Select-Object -First 1
if ($LASTEXITCODE -ne 0) { throw "ffmpeg not runnable" }

# ---------- bili-watch（内容层） ----------
Step "vendor/bili-watch"
$bw = Join-Path $vendor "bili-watch"
if (Test-Path (Join-Path $bw "tools\look.mjs")) {
    Write-Host "already cloned"
} else {
    git -c core.autocrlf=false clone --depth 1 https://github.com/Sacredbluedragon/dsh-bili-watch.git $bw
    if ($LASTEXITCODE -ne 0) { throw "git clone failed" }
}

Step "done"
Write-Host "yt-dlp : $shim"
Write-Host "ffmpeg : $ffmpeg"
Write-Host "bili   : $bw"
Write-Host "`n下一步：node cli\fav.mjs login（粘贴 Cookie）→ node cli\fav.mjs fetch --all"
