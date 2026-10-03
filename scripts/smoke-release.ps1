param([string]$Launcher = "$PSScriptRoot/../release/ClaudeBusinessDesk.Launcher.exe")
$ErrorActionPreference = 'Stop'
$launcherPath = (Resolve-Path -LiteralPath $Launcher).Path
$packageRoot = [IO.Path]::GetDirectoryName($launcherPath)
$busy = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -In 4309, 4310, 4311
if ($busy) { throw 'Release startup smoke needs a clean host with ports 4309, 4310 and 4311 free. Do not stop a running workbench just for this check.' }
$temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$data = Join-Path $temporaryRoot ('desk-release-smoke-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $data | Out-Null
$launcherProcess = $null
$backendProcess = $null
try {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $launcherPath
    $info.WorkingDirectory = $packageRoot
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
    $info.EnvironmentVariables['DESK_DATA_DIR'] = $data
    $launcherProcess = [Diagnostics.Process]::Start($info)
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $ready = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($launcherProcess.HasExited) { throw "Packaged launcher exited before startup ($($launcherProcess.ExitCode))." }
        $connectionPath = Join-Path $data 'connection.json'
        if (Test-Path -LiteralPath $connectionPath) {
            try {
                $connection = Get-Content -LiteralPath $connectionPath -Raw | ConvertFrom-Json
                $adminUrl = 'http://127.0.0.1:' + $connection.adminPort
                $adminMeta = Invoke-RestMethod -Uri ($adminUrl + '/api/meta') -TimeoutSec 2
                if ($adminMeta.portal -eq 'admin' -and $adminMeta.needsSetup -eq $true -and $connection.clientUrl) { $ready = $true; break }
            } catch { }
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Packaged launcher did not start fresh management and client portals within 45 seconds.' }
    $backendProcess = Get-Process -Id $connection.pid -ErrorAction Stop
    $expectedRuntime = Join-Path $packageRoot 'runtime/node.exe'
    if ([IO.Path]::GetFullPath($backendProcess.Path) -ne [IO.Path]::GetFullPath($expectedRuntime)) { throw 'Launcher did not use the bundled Node runtime.' }
    if ($connection.clientUrl -notmatch '^http://127\.0\.0\.1:\d+/?$') { throw 'Fresh client portal must listen only on loopback.' }
    $clientMeta = Invoke-RestMethod -Uri ($connection.clientUrl.TrimEnd('/') + '/api/meta') -TimeoutSec 5
    if ($clientMeta.portal -ne 'client') { throw 'Packaged client portal did not respond.' }
    foreach ($portalUrl in @($adminUrl, $connection.clientUrl)) {
        $page = Invoke-WebRequest -Uri $portalUrl -UseBasicParsing -TimeoutSec 5
        if ($page.StatusCode -ne 200 -or $page.Content -notmatch '/assets/[^" ]+\.js') { throw "Packaged web page failed: $portalUrl" }
        $asset = [regex]::Match($page.Content, '/assets/[^" ]+\.js').Value
        $script = Invoke-WebRequest -Uri ($portalUrl.TrimEnd('/') + $asset) -UseBasicParsing -TimeoutSec 5
        if ($script.StatusCode -ne 200 -or $script.RawContentLength -le 0) { throw 'Packaged frontend script failed to load.' }
    }
    Write-Output 'Packaged EXE startup passed: bundled runtime, fresh management and client portals, frontend assets. No Claude call or existing user data used.'
} finally {
    try {
        if ($launcherProcess) {
            if (-not $launcherProcess.HasExited) { Stop-Process -Id $launcherProcess.Id -Force -ErrorAction Stop }
            if (-not $launcherProcess.WaitForExit(10000)) { throw 'Test launcher did not stop.' }
        }
        if ($backendProcess -and -not $backendProcess.WaitForExit(10000)) { throw 'Launcher shutdown did not stop its bundled backend.' }
    } finally {
        if ($backendProcess) { $backendProcess.Dispose() }
        if ($launcherProcess) { $launcherProcess.Dispose() }
        $resolvedData = [IO.Path]::GetFullPath($data)
        if ([IO.Path]::GetDirectoryName($resolvedData).TrimEnd('\') -ne $temporaryRoot.TrimEnd('\') -or [IO.Path]::GetFileName($resolvedData) -notmatch '^desk-release-smoke-[a-f0-9]{32}$') { throw 'Refusing to remove a temporary path outside the release smoke directory.' }
        Remove-Item -LiteralPath $resolvedData -Recurse -Force
    }
}
