$ErrorActionPreference = 'Stop'
$taskProjectRoot = Split-Path $PSScriptRoot
$taskBrowserDirectory = Join-Path $taskProjectRoot '.tools/browser-runtime'
$taskBrowserCli = Join-Path $taskProjectRoot 'node_modules/playwright/cli.js'
if (-not (Test-Path -LiteralPath $taskBrowserCli)) { throw '먼저 ./scripts/npm.ps1 install로 프로젝트 의존성을 준비해 주세요.' }
$taskPreviousBrowserPath = $env:PLAYWRIGHT_BROWSERS_PATH
try {
    $env:PLAYWRIGHT_BROWSERS_PATH = $taskBrowserDirectory
    & (Join-Path $PSScriptRoot 'node.ps1') $taskBrowserCli install chromium --no-shell
    if ($LASTEXITCODE -ne 0) { throw '전용 Chromium 설치에 실패했습니다. 네트워크·회사 실행 정책을 확인해 주세요.' }
    $taskGuardCompiler = Join-Path $env:SystemRoot 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
    if (-not (Test-Path -LiteralPath $taskGuardCompiler)) { throw 'Windows .NET Framework C# 컴파일러를 찾지 못했습니다.' }
    $taskGuardDirectory = Join-Path $taskBrowserDirectory 'guard'
    New-Item -ItemType Directory -Force -Path $taskGuardDirectory | Out-Null
    & $taskGuardCompiler /nologo /target:exe "/out:$(Join-Path $taskGuardDirectory 'BrowserGuard.exe')" (Join-Path $taskProjectRoot 'backend/scripts/BrowserGuard.cs')
    if ($LASTEXITCODE -ne 0) { throw '브라우저 프로세스 가드 준비에 실패했습니다.' }
} finally { $env:PLAYWRIGHT_BROWSERS_PATH = $taskPreviousBrowserPath }
