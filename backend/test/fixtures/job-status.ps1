param([string]$OutputPath, [int]$TargetProcessId = $PID)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BrokerJobProbe {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
}
'@
$taskInJob = $false
if (-not [BrokerJobProbe]::IsProcessInJob((Get-Process -Id $TargetProcessId).Handle, [IntPtr]::Zero, [ref]$taskInJob)) { throw 'Job 조회 실패' }
@{ inJob = $taskInJob; processId = $TargetProcessId } | ConvertTo-Json | Set-Content -LiteralPath $OutputPath -Encoding utf8
