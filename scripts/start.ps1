$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $taskRoot '.tools/node-runtime/node.exe'))) { throw 'scripts/setup-runtime.ps1로 프로젝트 Node/npm을 먼저 준비해 주세요.' }
New-Item -ItemType Directory -Path (Join-Path $taskRoot '.logs') -Force | Out-Null
$taskShell = (Get-Process -Id $PID).Path
$taskLegacy = $false
try {
  $taskWeb = Invoke-WebRequest 'http://127.0.0.1:13002/api/health' -TimeoutSec 2 -SkipHttpErrorCheck
  if ($taskWeb.StatusCode -eq 200) {
    $taskRuntimeStatus = Invoke-RestMethod 'http://127.0.0.1:13002/api/runtime/status' -TimeoutSec 2 -SkipHttpErrorCheck
    $taskLegacy = $taskRuntimeStatus.role -ne 'gateway'
  }
} catch {}
if ($taskLegacy) { throw '이전 단일 서버가 실행 중입니다. 진행 중인 업무를 보호하기 위해 세션 서버를 중복 실행하지 않습니다. 기존 서버를 안전하게 종료한 뒤 다시 시작해 주세요.' }
foreach ($taskService in @('session','backend','frontend')) {
  $taskPort = if ($taskService -eq 'frontend') { 13001 } elseif ($taskService -eq 'session') { 13003 } else { 13002 }
  try { Invoke-WebRequest "http://127.0.0.1:$taskPort/" -TimeoutSec 2 -SkipHttpErrorCheck | Out-Null; Write-Output "$taskService 실행 중 ($taskPort)"; continue } catch {}
  $taskStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $taskScript = Join-Path $PSScriptRoot 'serve.ps1'
  $taskProcessId = & (Join-Path $PSScriptRoot 'start-detached.ps1') -FilePath $taskShell -Arguments "-NoProfile -NonInteractive -File `"$taskScript`" -Service $taskService" -WorkingDirectory $taskRoot -StandardOutput (Join-Path $taskRoot ".logs/$taskService-$taskStamp.log") -StandardError (Join-Path $taskRoot ".logs/$taskService-$taskStamp.error.log")
  Write-Output "$taskService 시작 요청 ($taskPort, 독립 프로세스 $taskProcessId)"
}
