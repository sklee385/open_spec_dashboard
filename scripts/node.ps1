$taskNode = Join-Path $PSScriptRoot '../.tools/node-runtime/node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) { throw '프로젝트 Node 런타임이 없습니다. scripts/setup-runtime.ps1을 먼저 실행해 주세요.' }
& $taskNode @args
exit $LASTEXITCODE
