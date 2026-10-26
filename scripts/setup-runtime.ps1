param([Parameter(Mandatory=$true)][string]$NodeDirectory)
$ErrorActionPreference = 'Stop'
$taskSource = (Resolve-Path -LiteralPath $NodeDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $taskSource 'node.exe')) -or -not (Test-Path -LiteralPath (Join-Path $taskSource 'node_modules/npm/bin/npm-cli.js'))) { throw 'Node 실행 파일과 npm이 들어 있는 설치 폴더를 지정해 주세요.' }
$taskTarget = Join-Path $PSScriptRoot '../.tools/node-runtime'
New-Item -ItemType Directory -Path (Join-Path $taskTarget 'node_modules') -Force | Out-Null
foreach ($taskFile in @('node.exe','npm','npm.cmd','npx','npx.cmd','LICENSE')) {
  Copy-Item -LiteralPath (Join-Path $taskSource $taskFile) -Destination (Join-Path $taskTarget $taskFile) -Force
}
Copy-Item -LiteralPath (Join-Path $taskSource 'node_modules/npm') -Destination (Join-Path $taskTarget 'node_modules') -Recurse -Force
Write-Output '프로젝트 전용 Node/npm 설치 완료'
