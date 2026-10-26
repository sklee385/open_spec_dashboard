param([Parameter(Mandatory)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'
$taskConfig = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
function Write-ProcessResult($Value, [string]$Path) {
    $taskTemporary = "$Path.$PID.tmp"
    $Value | ConvertTo-Json | Set-Content -LiteralPath $taskTemporary -Encoding utf8
    [IO.File]::Move($taskTemporary, $Path, $true)
}
try {
    $taskSecret = ConvertTo-SecureString $taskConfig.Environment
    $taskEnvironment = ([Net.NetworkCredential]::new('', $taskSecret)).Password | ConvertFrom-Json -AsHashtable
    foreach ($taskName in $taskEnvironment.Keys) { [Environment]::SetEnvironmentVariable($taskName, $taskEnvironment[$taskName], 'Process') }
    $taskProcess = Start-Process -FilePath $taskConfig.FilePath -ArgumentList $taskConfig.Arguments -WorkingDirectory $taskConfig.WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $taskConfig.StandardOutput -RedirectStandardError $taskConfig.StandardError -PassThru
    Write-ProcessResult @{ processId = $taskProcess.Id } $taskConfig.ResultPath
    $taskProcess.WaitForExit()
    Write-ProcessResult @{ processId = $taskProcess.Id; exitCode = $taskProcess.ExitCode; exitedAt = (Get-Date).ToString('o') } "$($taskConfig.ResultPath).exit.json"
} catch {
    Write-ProcessResult @{ error = $_.Exception.Message } $taskConfig.ResultPath
    exit 1
}
