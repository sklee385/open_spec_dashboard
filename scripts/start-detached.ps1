param([string]$FilePath, [string]$Arguments, [string]$WorkingDirectory, [string]$StandardOutput, [string]$StandardError)
$ErrorActionPreference = 'Stop'
$taskConfigPath = "$StandardOutput.launch.json"
$taskResultPath = "$StandardOutput.process.json"
if (Test-Path -LiteralPath $taskResultPath) { throw '프로세스 시작 결과 파일이 이미 있습니다. 새 로그 경로를 사용해 주세요.' }
$taskEnvironment = @{}
foreach ($taskName in @('PATH','CONFIG_PATH','OPENSPEC_UI_CONFIG','DATA_DIR','CODEX_BIN','CODEX_HOME','CODEX_ARGS','SESSION_PORT','PORT','NPM_BIN','OPENSPEC_NODE_DIRECTORY','OPENSPEC_DASHBOARD_URL','DESKTOP_TOKEN')) {
    $taskValue = [Environment]::GetEnvironmentVariable($taskName, 'Process')
    if ($null -ne $taskValue) { $taskEnvironment[$taskName] = $taskValue }
}
$taskEncryptedEnvironment = ConvertFrom-SecureString (ConvertTo-SecureString ($taskEnvironment | ConvertTo-Json -Compress) -AsPlainText -Force)
@{
    FilePath = $FilePath; Arguments = $Arguments; WorkingDirectory = $WorkingDirectory
    StandardOutput = $StandardOutput; StandardError = $StandardError
    ResultPath = $taskResultPath; Environment = $taskEncryptedEnvironment
} | ConvertTo-Json | Set-Content -LiteralPath $taskConfigPath -Encoding utf8
$taskShell = (Get-Process -Id $PID).Path
$taskRunner = Join-Path $PSScriptRoot 'run-independent.ps1'
$taskStartup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }
$taskCreated = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -OperationTimeoutSec 20 -Arguments @{
    CommandLine = "`"$taskShell`" -NoProfile -NonInteractive -WindowStyle Hidden -File `"$taskRunner`" -ConfigPath `"$taskConfigPath`""
    CurrentDirectory = $WorkingDirectory; ProcessStartupInformation = $taskStartup
}
if ($taskCreated.ReturnValue -ne 0) { throw "Windows 독립 프로세스 생성 실패 ($($taskCreated.ReturnValue)). 일반 PowerShell에서 scripts/start.ps1을 실행해 주세요." }
$taskDeadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path -LiteralPath $taskResultPath)) {
    if ((Get-Date) -ge $taskDeadline) { throw '독립 프로세스 시작 결과를 확인하지 못했습니다. 중복 실행하지 말고 .logs의 시작 결과를 확인해 주세요.' }
    Start-Sleep -Milliseconds 100
}
$taskResult = Get-Content -LiteralPath $taskResultPath -Raw | ConvertFrom-Json
if ($taskResult.error) { throw $taskResult.error }
[int]$taskResult.processId
