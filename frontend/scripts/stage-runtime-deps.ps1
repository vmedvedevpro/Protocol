# Stage Windows runtime dependencies for the NSIS installer: DirectML.dll and
# the pinned Visual C++ redistributable. The hooks copy DirectML.dll next to
# protocol.exe and run the redistributable when Visual C++ is missing.
$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$tauri = Join-Path $frontend "src-tauri"
$deps = Join-Path $tauri "runtime-deps"
New-Item -ItemType Directory -Force -Path $deps | Out-Null
# Clear what earlier builds staged here (the CUDA DLLs of the universal
# installer before 0.3.0): every staged file is packaged and installed.
Get-ChildItem -LiteralPath $deps -File | Where-Object {
  $_.Name -notin @(".gitkeep", "vc_redist.x64.exe")
} | Remove-Item -Force

function Assert-Pinned([string]$Path, [long]$Size, [string]$Sha256) {
  $item = Get-Item -LiteralPath $Path
  $hash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  if ($item.Length -ne $Size -or $hash -ne $Sha256) {
    throw "$Path is not the pinned build (size $($item.Length), SHA-256 $hash)"
  }
}

# DirectML 1.15.4, staged and verified by build/onnxruntime.rs during cargo build.
$directMl = Join-Path $tauri "binaries\onnxruntime\DirectML.dll"
if (-not (Test-Path -LiteralPath $directMl)) {
  throw "Required installer runtime missing: $directMl (run a cargo build first)"
}
Assert-Pinned $directMl 18527776 "9C9E6D822561C6C41B90E6994B3E8857CF1D66DBFB1E0C4C799C7C89B4E92DA1"
Copy-Item -LiteralPath $directMl (Join-Path $deps "DirectML.dll") -Force
Write-Host "staged DirectML.dll"

# Visual C++ 14.44.35211.0 from its versioned download URL, which embeds the
# hash: aka.ms/vs/17/release moves with every Microsoft refresh and would break
# the pin. Update URL, size and SHA-256 together.
$vc = Join-Path $deps "vc_redist.x64.exe"
$vcUrl = "https://download.visualstudio.microsoft.com/download/pr/990c720a-46ce-4dc7-87b9-c2eb615d34b9/CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B/VC_redist.x64.exe"
$vcSha256 = "CC0FF0EB1DC3F5188AE6300FAEF32BF5BEEBA4BDD6E8E445A9184072096B713B"
$vcSize = 25635768
if ((Test-Path -LiteralPath $vc) -and ((Get-FileHash $vc -Algorithm SHA256).Hash -ne $vcSha256)) {
  Write-Host "Replacing a VC++ Redistributable that is not the pinned build"
  Remove-Item -LiteralPath $vc -Force
}
if (-not (Test-Path -LiteralPath $vc)) {
  Write-Host "Downloading VC++ Redistributable x64 14.44.35211.0..."
  $partial = "$vc.partial"
  Invoke-WebRequest -Uri $vcUrl -OutFile $partial -UseBasicParsing
  Move-Item -LiteralPath $partial -Destination $vc -Force
}
Assert-Pinned $vc $vcSize $vcSha256
Write-Host "Runtime deps ready:"
Get-ChildItem $deps | ForEach-Object { Write-Host ("  " + $_.Name) }
