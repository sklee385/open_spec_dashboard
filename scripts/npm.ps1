$taskNode = Join-Path $PSScriptRoot '../.tools/node-runtime/node.exe'
$taskNpm = Join-Path $PSScriptRoot '../.tools/node-runtime/node_modules/npm/bin/npm-cli.js'
if (-not (Test-Path -LiteralPath $taskNpm)) { throw '프로젝트 npm 런타임이 없습니다. scripts/setup-runtime.ps1을 먼저 실행해 주세요.' }
$env:PATH = "$(Split-Path $taskNode);$env:PATH"
& $taskNode $taskNpm @args
exit $LASTEXITCODE
