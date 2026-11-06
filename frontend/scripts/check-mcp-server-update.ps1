# Updates an installed Protocol while an AI agent runs its MCP server (#8),
# the way the in-app updater does (/UPDATE), and checks that the server keeps
# running and answering while the update installs a new protocol-mcp.exe
# beside it (installer-hooks.nsh: Protocol_MoveRunningServerAside).
#
#   check-mcp-server-update.ps1 -InstallDir <installed Protocol> -Setup <setup.exe>
#
# Leaves the old server running and returns its process, so the caller can
# check that uninstalling stops it (Protocol_StopInstalledApp).
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$Setup
)

$ErrorActionPreference = 'Stop'
$server = Join-Path $InstallDir 'protocol-mcp.exe'
if (-not (Test-Path -LiteralPath $server)) { throw "protocol-mcp.exe is not installed in $InstallDir" }

$start = New-Object System.Diagnostics.ProcessStartInfo $server
$start.UseShellExecute = $false
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($start)

function Ask([string]$message, [int]$id) {
  $process.StandardInput.WriteLine($message)
  $process.StandardInput.Flush()
  while ($true) {
    $read = $process.StandardOutput.ReadLineAsync()
    if (-not $read.Wait(15000)) { throw "protocol-mcp did not answer request $id" }
    if ($null -eq $read.Result) { throw "protocol-mcp closed its output: $($process.StandardError.ReadToEnd())" }
    $answer = $read.Result | ConvertFrom-Json
    if ($answer.id -eq $id) { return $answer }
  }
}

$init = Ask '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"update-check","version":"0"}}}' 1
if ($init.result.serverInfo.name -ne 'protocol') { throw "Unexpected initialize answer: $($init | ConvertTo-Json -Compress -Depth 6)" }
$process.StandardInput.WriteLine('{"jsonrpc":"2.0","method":"notifications/initialized"}')
Write-Host "protocol-mcp $($init.result.serverInfo.version) is serving (process $($process.Id))."

$update = Start-Process -FilePath $Setup -ArgumentList '/S', '/UPDATE', "/D=$InstallDir" -Wait -PassThru
if ($update.ExitCode -ne 0) { throw "The update exited with $($update.ExitCode)" }
if ($process.HasExited) { throw "The update stopped the running MCP server (exit $($process.ExitCode))" }

$aside = @(Get-ChildItem -LiteralPath $InstallDir -Filter 'protocol-mcp.exe.old-*')
if ($aside.Count -ne 1) { throw "Expected the running server moved aside once, found: $($aside.Name -join ', ')" }
$version = & $server --version
if ($LASTEXITCODE -ne 0 -or $version -notlike 'protocol-mcp *') { throw "The updated protocol-mcp.exe does not run: $version" }

$tools = Ask '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' 2
$names = @($tools.result.tools | ForEach-Object { $_.name })
if ($names -notcontains 'list_meetings') { throw "The old server stopped answering: $($tools | ConvertTo-Json -Compress -Depth 4)" }
Write-Host "Updated beside the running server: it still lists $($names.Count) tools; $($aside.Name) holds the old copy; the new one reports $version."

return $process
