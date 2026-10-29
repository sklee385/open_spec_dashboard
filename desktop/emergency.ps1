param([string]$OwnerPath)
$ErrorActionPreference = 'Stop'
try {
  # This script is installed as resources/emergency/emergency.ps1.
  $appDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
  if (-not $OwnerPath) { $OwnerPath = Join-Path $env:APPDATA 'OpenSpecBoard/desktop-owner.json' }
  $runtime = Join-Path $appDirectory 'resources/service/runtime/node.exe'
  $entry = Join-Path $PSScriptRoot 'emergency.cjs'
  & $runtime $entry --owner $OwnerPath
  if ($LASTEXITCODE -ne 0) { throw 'Ownership could not be verified. No unrelated processes were terminated.' }
} catch {
  Add-Type -AssemblyName System.Windows.Forms
  [void][System.Windows.Forms.MessageBox]::Show('Emergency recovery failed. Verify the selected OpenSpecBoard profile and installation. Data files were retained.', 'OpenSpecBoard Emergency Recovery', 'OK', 'Error')
  exit 1
}
