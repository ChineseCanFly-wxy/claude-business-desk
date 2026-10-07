param([string]$DialogHost = "$PSScriptRoot/../dist/native/DeskDialogHost.exe")
$ErrorActionPreference = 'Stop'
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = (Resolve-Path -LiteralPath $DialogHost).Path
$info.Arguments = '--check-dialog'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [Diagnostics.Process]::Start($info)
try {
 if (-not $process.WaitForExit(30000)) { $process.Kill(); throw 'Native picker checks timed out' }
 $output = $process.StandardOutput.ReadToEnd()
 $errors = $process.StandardError.ReadToEnd()
 if ($process.ExitCode -ne 0) { throw "Native picker checks failed ($($process.ExitCode)): $errors" }
 Write-Output $output
} finally { $process.Dispose() }
