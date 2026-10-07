param([string]$Launcher = "$PSScriptRoot/../apps/launcher/publish/ClaudeBusinessDesk.Launcher.exe")
$ErrorActionPreference = 'Stop'
foreach ($check in @('--check-notifications', '--check-startup')) {
$info = [System.Diagnostics.ProcessStartInfo]::new()
$info.FileName = (Resolve-Path -LiteralPath $Launcher).Path
$info.Arguments = $check
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($info)
$output = $process.StandardOutput.ReadToEnd()
$errors = $process.StandardError.ReadToEnd()
$process.WaitForExit()
Write-Output $output
if ($process.ExitCode -ne 0) { throw "$check failed ($($process.ExitCode)): $errors" }
$process.Dispose()

}
