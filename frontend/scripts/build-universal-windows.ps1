# Builds protocol-windows-x64-setup.exe: one Tauri NSIS installer that bundles
# the CPU build as protocol.exe and carries the Vulkan build and its capability
# probe under installer-variants\. The NSIS hooks (windows\installer-hooks.nsh)
# run the probe at install and update time and replace protocol.exe with the
# Vulkan build only when the probe finds a usable device. The same file is the
# in-app updater's payload; the release workflow signs it for the updater.
#
# Local builds and the release workflow run the same steps:
#   powershell -NoProfile -ExecutionPolicy Bypass -File frontend\scripts\build-universal-windows.ps1 -AllowUnsigned
# Output: <OutputDir>\protocol-windows-x64-setup.exe and <OutputDir>\SHA256SUMS.txt
# (default OutputDir: <repo>\dist). Check it with verify-windows-release.mjs.
param(
  [string]$VulkanSdk,
  [string]$LlvmDir,
  [string]$OutputDir,
  [switch]$SkipFrontend,
  [switch]$AllowUnsigned
)

$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
$tauri = Join-Path $frontend "src-tauri"
$variants = Join-Path $tauri "installer-variants"
$sign = Join-Path $tauri "scripts\sign-windows.ps1"
$tauriCli = Join-Path $frontend "node_modules\@tauri-apps\cli\tauri.js"
$config = Get-Content (Join-Path $tauri "tauri.conf.json") -Raw | ConvertFrom-Json
$appVersion = $config.version
$assetName = "protocol-windows-x64-setup.exe"

function Resolve-FullPath([string]$Path) {
  $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
}

$target = if ($env:CARGO_TARGET_DIR) { Resolve-FullPath $env:CARGO_TARGET_DIR } else { Join-Path $repo "target" }
$env:CARGO_TARGET_DIR = $target
if (-not $OutputDir) { $OutputDir = Join-Path $repo "dist" }
$OutputDir = Resolve-FullPath $OutputDir

if (-not $env:DIGICERT_KEYPAIR_ALIAS -and -not $AllowUnsigned) {
  throw "DIGICERT_KEYPAIR_ALIAS is not set. Pass -AllowUnsigned to build an installer without Authenticode signatures."
}
if ($AllowUnsigned -and -not $env:DIGICERT_KEYPAIR_ALIAS) {
  Write-Warning "Building an installer without Authenticode signatures"
}

# Visual Studio 2022 (Build Tools locally, Enterprise on GitHub's windows-2022
# image). The whisper.cpp and llama.cpp builds are only known to work with it.
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) { throw "vswhere.exe is missing: install Visual Studio 2022 or its Build Tools" }
$vsInstall = & $vswhere -latest -products * -version "[17.0,18.0)" `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1
if (-not $vsInstall) { throw "Visual Studio 2022 with the x64 C++ tools is not installed" }
$vcvars = Join-Path $vsInstall.Trim() "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars)) { throw "Visual Studio x64 tools are missing: $vcvars" }

# Import vcvars64 into this PowerShell process.
cmd /c "call `"$vcvars`" >nul 2>&1 && set" | ForEach-Object {
  if ($_ -match '^([^=]+)=(.*)$') {
    [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
  }
}

function Build-VulkanProbe([string]$Sdk) {
  Write-Host ""
  Write-Host "=== Building Vulkan capability probe ==="
  $source = Join-Path $tauri "vulkan-probe\vulkan_probe.cpp"
  $header = Join-Path $Sdk "Include\vulkan\vulkan.h"
  $build = Join-Path $target "vulkan-probe\release"
  $object = Join-Path $build "vulkan_probe.obj"
  $binary = Join-Path $build "protocol-vulkan-probe.exe"
  foreach ($required in @($source, $header)) {
    if (-not (Test-Path -LiteralPath $required)) {
      throw "Vulkan probe input missing: $required"
    }
  }
  New-Item -ItemType Directory -Force -Path $build | Out-Null
  & cl.exe /nologo /O2 /MT /W4 /EHsc /std:c++17 /DUNICODE /D_UNICODE /DNOMINMAX `
    "/D_WIN32_WINNT=0x0A00" /I (Join-Path $Sdk "Include") /c $source /Fo"$object" | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "Vulkan capability probe compilation failed" }
  & link.exe /nologo /SUBSYSTEM:CONSOLE /MACHINE:X64 /OPT:REF /OPT:ICF `
    /OUT:"$binary" "$object" kernel32.lib | Out-Host
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $binary)) {
    throw "Vulkan capability probe link failed"
  }
  return $binary
}

# Keeps each EXE/PDB pair for crash symbolication: the next cargo or Tauri
# build in the same target dir overwrites release\protocol.exe and its PDB.
function Save-Symbols([string]$Name) {
  $pdb = Join-Path $target "release\protocol.pdb"
  if (Test-Path -LiteralPath $pdb) {
    $symbols = Join-Path $target "release-symbols\$appVersion\$Name"
    New-Item -ItemType Directory -Force -Path $symbols | Out-Null
    Copy-Item (Join-Path $target "release\protocol.exe") (Join-Path $symbols "protocol.exe") -Force
    Copy-Item $pdb (Join-Path $symbols "protocol.pdb") -Force
  }
}

function Invoke-Node([string[]]$NodeArgs) {
  & node @NodeArgs
  if ($LASTEXITCODE -ne 0) { throw "node $($NodeArgs -join ' ') failed" }
}

if (-not $LlvmDir) { $LlvmDir = $env:MEETILY_LLVM_DIR }
if (-not $LlvmDir) { $LlvmDir = "C:\Program Files\LLVM" }
# bindgen needs libclang.dll and clang's builtin headers, nothing else; the
# bootstrap extracts only those, so clang.exe may be absent. The DLL's version
# resource names its LLVM release.
$libclangDll = Join-Path $LlvmDir "bin\libclang.dll"
$libclangMajor = if (Test-Path -LiteralPath $libclangDll) { (Get-Item -LiteralPath $libclangDll).VersionInfo.FileMajorPart } else { 0 }
if ($libclangMajor -ne 18 -or -not (Test-Path -LiteralPath (Join-Path $LlvmDir "lib\clang\18\include"))) {
  $LlvmDir = & (Join-Path $PSScriptRoot "bootstrap-llvm18.ps1") | Select-Object -Last 1
}
$env:LIBCLANG_PATH = Join-Path $LlvmDir "bin"
if (-not (Test-Path (Join-Path $env:LIBCLANG_PATH "libclang.dll"))) {
  throw "Compatible LLVM/libclang not found at $LlvmDir (LLVM 18 recommended)"
}
# Bundled whisper-rs bindings are Linux-shaped in 0.13.x. Windows builds must
# generate their own bindings via libclang.
Remove-Item Env:WHISPER_DONT_GENERATE_BINDINGS -ErrorAction SilentlyContinue

if (-not (Get-Command cmake.exe -ErrorAction SilentlyContinue)) {
  $env:PATH = "C:\Program Files\CMake\bin;$env:PATH"
  if (-not (Get-Command cmake.exe -ErrorAction SilentlyContinue)) { throw "CMake is not installed" }
}
# Ninja when it is available (the runner image has it on PATH, vcvars adds
# Visual Studio's copy when its CMake component is installed); otherwise CMake
# falls back to its Visual Studio generator, which is slower but works.
Remove-Item Env:CMAKE_GENERATOR_INSTANCE -ErrorAction SilentlyContinue
if (Get-Command ninja.exe -ErrorAction SilentlyContinue) {
  $env:CMAKE_GENERATOR = "Ninja"
} else {
  Remove-Item Env:CMAKE_GENERATOR -ErrorAction SilentlyContinue
  Write-Host "Ninja not found: CMake uses its default Visual Studio generator"
}

if (-not $SkipFrontend) {
  Push-Location $frontend
  try {
    Invoke-Node @("node_modules\next\dist\bin\next", "build")
  } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $frontend "out\index.html"))) {
  throw "frontend\out is missing: run without -SkipFrontend"
}

if (-not $VulkanSdk) { $VulkanSdk = $env:VULKAN_SDK }
if (-not $VulkanSdk -or -not (Test-Path (Join-Path $VulkanSdk "Bin\glslc.exe"))) {
  $VulkanSdk = & (Join-Path $PSScriptRoot "bootstrap-vulkan-build-tools.ps1") | Select-Object -Last 1
}
$VulkanSdk = Resolve-FullPath $VulkanSdk
$vulkanProbeBinary = Build-VulkanProbe $VulkanSdk

# Both variants share one target dir. Only whisper-rs-sys, whisper-rs and
# protocol differ between the feature sets, so the CPU build after the Vulkan
# one recompiles just those. Order matters: the Vulkan executable is copied out
# before `tauri build` relinks release\protocol.exe as the CPU build it bundles.
Write-Host ""
Write-Host "=== Building the Vulkan variant ==="
$savedEnv = @{}
foreach ($name in @("PATH", "VULKAN_SDK", "VK_SDK_PATH", "Vulkan_LIBRARY", "Vulkan_INCLUDE_DIR")) {
  $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
$env:VULKAN_SDK = $VulkanSdk
$env:VK_SDK_PATH = $VulkanSdk
$env:Vulkan_LIBRARY = Join-Path $VulkanSdk "Lib\vulkan-1.lib"
$env:Vulkan_INCLUDE_DIR = Join-Path $VulkanSdk "Include"
$env:PATH = "$(Join-Path $VulkanSdk 'Bin');$env:PATH"
Push-Location $repo
try {
  & cargo build --release --locked -p protocol --bin protocol --no-default-features --features "custom-protocol,vulkan"
  if ($LASTEXITCODE -ne 0) { throw "Vulkan build failed" }
} finally { Pop-Location }
# The CPU build must not see the SDK: build scripts that watch these variables
# would rebuild, and a CPU build must not depend on Vulkan in any way.
foreach ($name in $savedEnv.Keys) {
  [Environment]::SetEnvironmentVariable($name, $savedEnv[$name], 'Process')
}
$vulkanBinary = Join-Path $target "release\protocol.exe"
if (-not (Test-Path -LiteralPath $vulkanBinary)) { throw "Vulkan binary missing: $vulkanBinary" }
Save-Symbols "vulkan"

foreach ($sidecar in @("llama-helper-x86_64-pc-windows-msvc.exe", "ffmpeg-x86_64-pc-windows-msvc.exe")) {
  $sidecarPath = Join-Path $tauri "binaries\$sidecar"
  if (-not (Test-Path $sidecarPath)) {
    throw "Required sidecar missing: $sidecarPath (llama-helper: cargo build --release -p llama-helper, then copy it there; ffmpeg: downloaded by the cargo build)"
  }
}

New-Item -ItemType Directory -Force -Path $variants | Out-Null
# installer-variants is gitignored and survives branch switches. Remove what an
# earlier build staged (the CPU and CUDA variants before 0.3.0, meetily-*.exe
# before #12) so it is not packaged; only .gitkeep stays.
Get-ChildItem -LiteralPath $variants -File | Where-Object { $_.Name -ne ".gitkeep" } | Remove-Item -Force
$vulkanVariant = Join-Path $variants "protocol-vulkan.exe"
Copy-Item $vulkanBinary $vulkanVariant -Force
# The bundler marks only the executable it packages as "nsis"; the updater
# reads that marker, so the variant that replaces it needs the same bytes.
# Patch before signing: changing a signed file would break its signature.
Invoke-Node @((Join-Path $repo "scripts\release\patch-bundle-type.mjs"), $vulkanVariant, "nsis")
Copy-Item $vulkanProbeBinary (Join-Path $variants "protocol-vulkan-probe.exe") -Force

& (Join-Path $PSScriptRoot "stage-runtime-deps.ps1")

foreach ($binary in Get-ChildItem $variants -Filter "*.exe") {
  & $sign -FilePath $binary.FullName
  if ($LASTEXITCODE -ne 0) { throw "Signing failed: $($binary.FullName)" }
}

# With #31's updater configuration, `tauri build` signs the installer for the
# updater and fails without a private key. A local or CI build gets a throwaway
# key; the release workflow signs the final file again with the real key.
$updaterConfigured = ($config.bundle.createUpdaterArtifacts -eq $true) -and $config.plugins -and
  $config.plugins.updater -and $config.plugins.updater.pubkey
if ($updaterConfigured -and -not $env:TAURI_SIGNING_PRIVATE_KEY) {
  $keyDir = Join-Path $target "updater-ephemeral-key"
  Remove-Item -LiteralPath $keyDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $keyDir | Out-Null
  $ephemeralKey = Join-Path $keyDir "ephemeral.key"
  Invoke-Node @($tauriCli, "signer", "generate", "--ci", "-w", $ephemeralKey)
  $env:TAURI_SIGNING_PRIVATE_KEY = $ephemeralKey
  Write-Host "Signing the updater payload with a throwaway key; the release workflow re-signs it"
} elseif (-not $updaterConfigured) {
  Write-Host "tauri.conf.json has no updater configuration: no updater signature is produced"
}

$universalMarker = Join-Path $variants "universal.marker"
try {
  [System.IO.File]::WriteAllText($universalMarker, "universal`r`n")
  # Bundle with the CPU build as the main executable: it starts everywhere,
  # and the hook replaces it only when the Vulkan probe succeeds.
  Write-Host ""
  Write-Host "=== Building the CPU variant and the installer ==="
  Push-Location $frontend
  try {
    # --ci: no prompts; an unset key password then means an empty one.
    Invoke-Node @($tauriCli, "build", "--ci", "--bundles", "nsis", "--config", "src-tauri\tauri.universal.conf.json",
      "--", "--locked", "--no-default-features", "--features", "custom-protocol")
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item $universalMarker -Force -ErrorAction SilentlyContinue
}
Save-Symbols "cpu"

$installer = Join-Path $target "release\bundle\nsis\Protocol_${appVersion}_x64-setup.exe"
if (-not (Test-Path $installer)) { throw "Installer missing: $installer" }
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$output = Join-Path $OutputDir $assetName
Copy-Item $installer $output -Force
$checksums = Join-Path $OutputDir "SHA256SUMS.txt"
[System.IO.File]::WriteAllText(
  $checksums,
  ("{0}  {1}`n" -f (Get-FileHash $output -Algorithm SHA256).Hash.ToLowerInvariant(), $assetName),
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host ""
Write-Host "Windows installer ready: $output"
Get-Item $output, $checksums | Select-Object FullName, Length, LastWriteTime
