param(
  [Parameter(Mandatory = $true)]
  [string]$ProgressMainBinary
)

$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
$tauri = Join-Path $frontend "src-tauri"
$source = Join-Path $tauri "nsis-progress"
$version = (Get-Content (Join-Path $tauri "tauri.conf.json") -Raw | ConvertFrom-Json).version
$build = Join-Path $repo "target\nsis-progress\$version"
$nsis = Join-Path $env:LOCALAPPDATA "tauri\NSIS"
$pluginDir = Join-Path $nsis "Plugins\x86-unicode"
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) { throw "Visual Studio locator not found: $vswhere" }
$vsInstall = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
$vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvars32.bat"

foreach ($required in @($ProgressMainBinary, $source, $vcvars)) {
  if (-not (Test-Path -LiteralPath $required)) { throw "NSIS progress input missing: $required" }
}
# tauri-bundler 2.10 (CLI 2.12) deletes and re-downloads this toolset unless
# NSIS.exe is its NSIS 3.13 and nsis_tauri_utils.dll is present, which would
# also delete MeetilyProgress.dll and silently build the installer without it.
# Prepare exactly the toolset the bundler expects (same URLs and SHA-1 values
# as tauri-bundler's nsis/mod.rs) before installing the plugin.
$nsisArchiveUrl = "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip"
$nsisArchiveSha1 = "DB14F8AF2EA346B786C6AE19343F61AAF5E09B8E"
$nsisExeSha1 = "6D45D4E8CCF18FE1FDAC9164058F356102A2ECF2"
$tauriUtilsUrl = "https://github.com/tauri-apps/nsis-tauri-utils/releases/download/nsis_tauri_utils-v0.5.3/nsis_tauri_utils.dll"
$tauriUtilsSha1 = "75197FEE3C6A814FE035788D1C34EAD39349B860"
function Test-Sha1([string]$Path, [string]$Expected) {
  (Test-Path -LiteralPath $Path) -and ((Get-FileHash -LiteralPath $Path -Algorithm SHA1).Hash -eq $Expected)
}
if (-not (Test-Sha1 (Join-Path $nsis "NSIS.exe") $nsisExeSha1)) {
  $archive = Join-Path $repo ".build-tools\nsis-3.13.zip"
  New-Item -ItemType Directory -Force -Path (Split-Path $archive -Parent) | Out-Null
  if (-not (Test-Sha1 $archive $nsisArchiveSha1)) {
    Invoke-WebRequest -Uri $nsisArchiveUrl -OutFile $archive
    if (-not (Test-Sha1 $archive $nsisArchiveSha1)) { throw "NSIS 3.13 archive failed its SHA-1 check: $archive" }
  }
  $toolsDir = Split-Path $nsis -Parent
  $expanded = Join-Path $toolsDir "nsis-3.13"
  foreach ($stale in @($nsis, $expanded)) {
    if (Test-Path -LiteralPath $stale) { Remove-Item -LiteralPath $stale -Recurse -Force }
  }
  New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
  Expand-Archive -LiteralPath $archive -DestinationPath $toolsDir -Force
  Move-Item -LiteralPath $expanded -Destination $nsis
}
$tauriUtils = Join-Path $nsis "Plugins\x86-unicode\additional\nsis_tauri_utils.dll"
if (-not (Test-Sha1 $tauriUtils $tauriUtilsSha1)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $tauriUtils -Parent) | Out-Null
  Invoke-WebRequest -Uri $tauriUtilsUrl -OutFile $tauriUtils
  if (-not (Test-Sha1 $tauriUtils $tauriUtilsSha1)) { throw "nsis_tauri_utils.dll failed its SHA-1 check: $tauriUtils" }
}
New-Item -ItemType Directory -Force -Path $build | Out-Null
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null

$files = [System.Collections.Generic.List[object]]::new()
function Add-ProgressFile([string]$RelativePath, [string]$SourcePath) {
  if ($SourcePath -and (Test-Path -LiteralPath $SourcePath)) {
    $files.Add([PSCustomObject]@{ RelativePath = $RelativePath; Length = (Get-Item -LiteralPath $SourcePath).Length })
  }
}
Add-ProgressFile "protocol.exe" $ProgressMainBinary
foreach ($name in @(".gitkeep", "protocol-cpu.exe", "protocol-cuda.exe", "protocol-vulkan-probe.exe", "protocol-vulkan.exe", "universal.marker")) {
  Add-ProgressFile "installer-variants\$name" (Join-Path $tauri "installer-variants\$name")
}
foreach ($name in @("parakeet-rs-LICENSE.txt", "THIRD_PARTY_MODELS.txt", "segmentation-3.0-fp16.onnx", "wespeaker-resnet34-LM.onnx", "xvec_transform.npz")) {
  Add-ProgressFile "resources\diarization\$name" (Join-Path $tauri "resources\diarization\$name")
}
foreach ($name in @("DirectML.dll", "cublas64_13.dll", "cublasLt64_13.dll", "cudart64_13.dll", "vc_redist.x64.exe")) {
  Add-ProgressFile "runtime-deps\$name" (Join-Path $tauri "runtime-deps\$name")
}
foreach ($name in @("onnxruntime.dll", "onnxruntime_providers_shared.dll", "onnxruntime-LICENSE.txt", "DirectML.dll", "DirectML-LICENSE.txt")) {
  Add-ProgressFile "binaries\onnxruntime\$name" (Join-Path $tauri "binaries\onnxruntime\$name")
}
Get-ChildItem (Join-Path $tauri "templates") -Filter "*.json" | Sort-Object Name | ForEach-Object {
  Add-ProgressFile "templates\$($_.Name)" $_.FullName
}
Add-ProgressFile "ffmpeg.exe" (Join-Path $tauri "binaries\ffmpeg-x86_64-pc-windows-msvc.exe")
Add-ProgressFile "llama-helper.exe" (Join-Path $tauri "binaries\llama-helper-x86_64-pc-windows-msvc.exe")

$entries = ($files | ForEach-Object {
  $path = $_.RelativePath.Replace("\", "\\").Replace('"', '\"')
  "  { L`"$path`", $($_.Length)ULL },"
}) -join "`r`n"
$total = ($files | Measure-Object Length -Sum).Sum
$header = Join-Path $build "progress_files.h"
[System.IO.File]::WriteAllText(
  $header,
  "#pragma once`r`nstatic constexpr wchar_t kMeetilyVersion[] = L`"$version`";`r`nstruct BundledFileInfo { const wchar_t* path; unsigned long long size; };`r`nstatic constexpr BundledFileInfo kBundledFiles[] = {`r`n$entries`r`n};`r`nstatic constexpr unsigned long long kBundledFilesTotalBytes = ${total}ULL;`r`n",
  [System.Text.UTF8Encoding]::new($false)
)

$dll = Join-Path $build "MeetilyProgress.dll"
$object = Join-Path $build "MeetilyProgress.obj"
$cpp = Join-Path $source "MeetilyProgress.cpp"
$def = Join-Path $source "MeetilyProgress.def"
$command = "call `"$vcvars`" >nul && cl.exe /nologo /O2 /MT /W4 /EHsc /std:c++17 /DUNICODE /D_UNICODE /I`"$build`" /Fo`"$object`" `"$cpp`" comctl32.lib uxtheme.lib user32.lib /link /DEF:`"$def`" /OUT:`"$dll`""
cmd /c $command
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $dll)) {
  throw "NSIS overall-progress plugin build failed"
}
Copy-Item -LiteralPath $dll -Destination (Join-Path $pluginDir "MeetilyProgress.dll") -Force
Write-Host "NSIS overall-progress plugin ready: $dll"
