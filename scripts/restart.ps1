param([ValidateSet('frontend','backend','session')][string]$Service = 'backend')
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot
$taskPort = if ($Service -eq 'frontend') { 13001 } elseif ($Service -eq 'session') { 13003 } else { 13002 }
if ($Service -eq 'session') {
  $taskWork = Invoke-RestMethod "http://127.0.0.1:$taskPort/api/work" -TimeoutSec 5
  if (@($taskWork.work | Where-Object { $_.state -in @('running','waiting-input','waiting-approval','connecting','creating-thread') }).Count) {
    throw '진행 중이거나 답변·승인 대기 중인 업무가 있습니다. 세션 서버 재시작을 보류합니다. 웹 서버만 재시작하려면 -Service backend를 사용해 주세요.'
  }
}
if ($Service -eq 'backend') {
  $taskStatus = Invoke-RestMethod 'http://127.0.0.1:13002/api/runtime/status' -TimeoutSec 5 -SkipHttpErrorCheck
  if ($taskStatus.role -ne 'gateway') { throw '기존 단일 서버는 이 명령으로 종료하지 않습니다. 진행 업무를 확인하고 분리 구조로 전환해 주세요.' }
}
$taskListener = Get-NetTCPConnection -LocalPort $taskPort -State Listen -ErrorAction SilentlyContinue
if ($taskListener) {
  $taskProcessId = $taskListener.OwningProcess | Select-Object -Unique
  $taskProcess = Get-Process -Id $taskProcessId
  $taskExpected = [System.IO.Path]::GetFullPath((Join-Path $taskRoot '.tools/node-runtime/node.exe'))
  if ($taskProcess.Path -ne $taskExpected) { throw '프로젝트 Node 런타임으로 실행한 서버가 아닙니다. 다른 프로세스를 종료하지 않았습니다.' }
  & taskkill.exe /PID $taskProcessId /T /F
  if ($LASTEXITCODE -ne 0) { throw '서버 종료를 확인하지 못했습니다.' }
}
& (Join-Path $PSScriptRoot 'start.ps1')
