param([string]$Launcher = "$PSScriptRoot/../apps/launcher/publish/ClaudeBusinessDesk.Launcher.exe")
$ErrorActionPreference = 'Stop'
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = (Resolve-Path -LiteralPath $Launcher).Path
$info.Arguments = '--check-notifications'
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($info)
$output = $process.StandardOutput.ReadToEnd()
$errors = $process.StandardError.ReadToEnd()
$process.WaitForExit()
Write-Output $output
if ($process.ExitCode -ne 0) { throw "Notification checks failed ($($process.ExitCode)): $errors" }
$process.Dispose()
