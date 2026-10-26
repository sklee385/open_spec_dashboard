param([ValidateSet('frontend','backend','session')][string]$Service)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot
$taskRuntime = Join-Path $taskRoot '.tools/node-runtime'
$env:PATH = "$taskRuntime;$env:PATH"
Set-Location -LiteralPath (Join-Path $taskRoot $(if ($Service -eq 'frontend') { 'frontend' } else { 'backend' }))
if ($Service -eq 'frontend') {
  & (Join-Path $taskRuntime 'node.exe') --max-old-space-size=384 --max-semi-space-size=4 ../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 13001 --strictPort
} elseif ($Service -eq 'session') {
  & (Join-Path $taskRuntime 'node.exe') --max-old-space-size=256 --max-semi-space-size=4 dist/session-main.js
} else {
  & (Join-Path $taskRuntime 'node.exe') --max-old-space-size=256 --max-semi-space-size=4 dist/main.js
}
exit $LASTEXITCODE
