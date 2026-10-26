param(
  [string]$ToolRoot
)

$ErrorActionPreference = "Stop"
$frontend = Split-Path $PSScriptRoot -Parent
$repo = Split-Path $frontend -Parent
if (-not $ToolRoot) {
  $ToolRoot = Join-Path $repo ".build-tools"
}

$llvm = Join-Path $ToolRoot "clang+llvm-18.1.8-x86_64-pc-windows-msvc"
$libclang = Join-Path $llvm "bin\libclang.dll"
if (Test-Path $libclang) {
  Write-Host "LLVM 18 already ready: $llvm"
  $llvm
  exit 0
}

New-Item -ItemType Directory -Force -Path $ToolRoot | Out-Null
$archive = Join-Path $ToolRoot "clang+llvm-18.1.8-x86_64-pc-windows-msvc.tar.xz"
$expectedSha256 = "22C5907DB053026CC2A8FF96D21C0F642A90D24D66C23C6D28EE7B1D572B82E8"
if (-not (Test-Path $archive)) {
  Write-Host "Downloading portable LLVM 18 (required for whisper-rs Windows bindings)..."
  # curl rather than gh release download, which stalled for more than 20
  # minutes without output on the windows-2022 runner. A transfer slower than
  # 100 KB/s for a minute is aborted and retried; the partial file is renamed
  # only after a complete download, so a broken one is never hashed or cached.
  $url = "https://github.com/llvm/llvm-project/releases/download/llvmorg-18.1.8/clang+llvm-18.1.8-x86_64-pc-windows-msvc.tar.xz"
  $partial = "$archive.partial"
  # The script's output is the LLVM path, so the transfer summary goes to the host.
  $transfer = & curl.exe --fail --location --silent --show-error --retry 3 --connect-timeout 30 `
    --speed-limit 102400 --speed-time 60 --output $partial `
    --write-out 'Downloaded %{size_download} bytes in %{time_total} s' $url
  if ($LASTEXITCODE -ne 0) { throw "Failed to download LLVM 18 (curl exit $LASTEXITCODE)" }
  Write-Host $transfer
  Move-Item -Force $partial $archive
}
$actualSha256 = (Get-FileHash $archive -Algorithm SHA256).Hash
if ($actualSha256 -ne $expectedSha256) {
  throw "LLVM 18 archive checksum mismatch: $actualSha256"
}

# bindgen needs only libclang.dll and clang's builtin headers, which libclang
# finds relative to itself; extracting just those skips several GB of the
# toolchain. 7-Zip (preinstalled on the runner) decompresses xz on several
# threads: 4 s here against 39 s for tar. cmd carries the pipe because Windows
# PowerShell would turn the binary stream into text.
$top = Split-Path $llvm -Leaf
$sevenZip = @($env:SEVEN_ZIP, "$env:ProgramFiles\7-Zip\7z.exe", (Join-Path $repo ".build-tools\7zip\7z.exe")) |
  Where-Object { $_ -and (Test-Path $_) } |
  Select-Object -First 1
if ($sevenZip) {
  cmd /d /c "`"$sevenZip`" x -so `"$archive`" | `"$sevenZip`" x -si -ttar -y `"-o$ToolRoot`" `"$top\bin\libclang.dll`" `"$top\lib\clang\18\include`" -r- >nul"
} else {
  tar -xf $archive -C $ToolRoot "$top/bin/libclang.dll" "$top/lib/clang/18/include"
}
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $libclang)) {
  throw "Failed to extract portable LLVM 18"
}

Write-Host "LLVM 18 ready: $llvm"
$llvm
