$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class DeskDialogSmoke {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr p);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
}
'@
$root = Split-Path $PSScriptRoot -Parent
$output = Join-Path $env:TEMP ('desk-dialog-' + [Guid]::NewGuid() + '.json')
$p = Start-Process (Join-Path $root 'dist\native\DeskDialogHost.exe') -ArgumentList 'directory',($env:SystemDrive + '\') -PassThru -RedirectStandardOutput $output
# Supply a nonempty second argument without shell quoting the project directory.
# Start-Process flattens arguments, so this fixture uses the single-token system drive.
try {
 Start-Sleep -Seconds 3
 if ($p.HasExited) { throw 'Dialog exited before cancellation' }
 [void][DeskDialogSmoke]::EnumWindows({ param($h,$x)
  [uint32]$owner = 0
  [void][DeskDialogSmoke]::GetWindowThreadProcessId($h,[ref]$owner)
  if ($owner -eq $p.Id) { [void][DeskDialogSmoke]::PostMessage($h,16,[IntPtr]::Zero,[IntPtr]::Zero) }
  return $true
 }, [IntPtr]::Zero)
 if (-not $p.WaitForExit(10000)) { throw 'Dialog cancellation timed out' }
 $result = Get-Content $output -Raw | ConvertFrom-Json
 if ($p.ExitCode -ne 0 -or $null -ne $result.path) { throw 'Unexpected dialog cancellation result' }
 Write-Output 'Native directory dialog cancellation returned path:null.'
} finally {
 if (-not $p.HasExited) { Stop-Process -Id $p.Id }
 Remove-Item $output -ErrorAction SilentlyContinue
}
