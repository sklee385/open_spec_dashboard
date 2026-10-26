param([string]$Runtime, [string]$Launcher, [string]$Directory, [switch]$ExpectAttached)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LaunchJobProbe {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint length);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
}
'@
$taskProcess = $null
$taskJob = [LaunchJobProbe]::CreateJobObject([IntPtr]::Zero, $null)
$taskLimits = [Runtime.InteropServices.Marshal]::AllocHGlobal(144)
try {
    for ($taskOffset = 0; $taskOffset -lt 144; $taskOffset++) { [Runtime.InteropServices.Marshal]::WriteByte($taskLimits, $taskOffset, 0) }
    [Runtime.InteropServices.Marshal]::WriteInt32($taskLimits, 16, 0x800)
    if (-not [LaunchJobProbe]::SetInformationJobObject($taskJob, 9, $taskLimits, 144)) { throw '테스트 Job 설정 실패' }
    if (-not [LaunchJobProbe]::AssignProcessToJobObject($taskJob, (Get-Process -Id $PID).Handle)) { throw '테스트 부모 Job 연결 실패' }
    $env:CONFIG_PATH = Join-Path $Directory 'isolated config.json'
    $env:DESKTOP_TOKEN = 'launch-test-private-value'
    $taskProcessId = & $Launcher -FilePath $Runtime -Arguments '-e "console.log(process.pid); console.log(process.env.CONFIG_PATH); console.error(''stderr-ready''); setTimeout(() => {}, 60000)"' -WorkingDirectory $Directory -StandardOutput (Join-Path $Directory 'stdout.log') -StandardError (Join-Path $Directory 'stderr.log')
    $taskProcess = Get-Process -Id $taskProcessId
    $taskInJob = $false
    if (-not [LaunchJobProbe]::IsProcessInJob($taskProcess.Handle, $taskJob, [ref]$taskInJob)) { throw '프로세스 Job 확인 실패' }
    if ($taskInJob -ne $ExpectAttached.IsPresent) { throw '서버의 Windows Job 상속 상태가 예상과 다릅니다.' }
    if (-not $ExpectAttached) {
        if (-not [LaunchJobProbe]::IsProcessInJob($taskProcess.Handle, [IntPtr]::Zero, [ref]$taskInJob)) { throw '전체 Job 조회 실패' }
        if ($taskInJob) { throw '서버에 상위 Windows Job 연결이 남아 있습니다.' }
    }
    $taskDeadline = (Get-Date).AddSeconds(5)
    do {
        if ((Test-Path (Join-Path $Directory 'stdout.log')) -and (Get-Content (Join-Path $Directory 'stdout.log') -Raw) -match "$taskProcessId") { break }
        Start-Sleep -Milliseconds 50
    } while ((Get-Date) -lt $taskDeadline)
    if ((Get-Content (Join-Path $Directory 'stdout.log') -Raw) -notmatch "$taskProcessId") { throw 'stdout 로그 전달 실패' }
    if ((Get-Content (Join-Path $Directory 'stderr.log') -Raw) -notmatch 'stderr-ready') { throw 'stderr 로그 전달 실패' }
    if (-not (Get-Content (Join-Path $Directory 'stdout.log') -Raw).Contains($env:CONFIG_PATH)) { throw '사용자 실행 환경이 전달되지 않았습니다.' }
    if (-not $ExpectAttached -and (Get-Content (Join-Path $Directory 'stdout.log.launch.json') -Raw).Contains($env:DESKTOP_TOKEN)) { throw '인증 정보가 시작 기록에 평문으로 저장되었습니다.' }
    if ($ExpectAttached) { 'old launcher inherits the command job' } else { 'independent process and redirected logs verified' }
} finally {
    if ($taskProcess -and -not $taskProcess.HasExited) { Stop-Process -Id $taskProcess.Id -Force }
    [Runtime.InteropServices.Marshal]::FreeHGlobal($taskLimits)
    [LaunchJobProbe]::CloseHandle($taskJob) | Out-Null
}
