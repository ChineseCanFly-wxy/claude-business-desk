param([switch]$Install, [switch]$Build)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
if (-not $env:DESK_DATA_DIR) { $env:DESK_DATA_DIR = Join-Path $env:LOCALAPPDATA 'ClaudeBusinessDesk' }
New-Item -ItemType Directory -Force -Path $env:DESK_DATA_DIR | Out-Null
$bundled = Join-Path $root 'runtime/node.exe'
if (Test-Path -LiteralPath $bundled) { $node = $bundled } else { $node = (Get-Command node.exe -ErrorAction Stop).Source }
if ($Install) {
    & npm.cmd install
    if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }
}
if ($Build) {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'npm build failed.' }
}
$entry = Join-Path $root 'dist/server/main.js'
if (-not (Test-Path -LiteralPath $entry)) { throw 'Missing dist/server/main.js. In the source checkout, run scripts/启动.cmd -Install -Build after the server source is ready.' }
Write-Host 'Admin: http://localhost:4310  Client: http://localhost:4311'
Write-Host "Data: $env:DESK_DATA_DIR"
Write-Host 'Foreground server. Ctrl+C stops it. No firewall changes are made.'
& $node $entry
exit $LASTEXITCODE
