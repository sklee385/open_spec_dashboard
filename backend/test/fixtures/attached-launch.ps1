param([string]$FilePath, [string]$Arguments, [string]$WorkingDirectory, [string]$StandardOutput, [string]$StandardError)
$ErrorActionPreference = 'Stop'
$taskProcess = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory -WindowStyle Hidden -RedirectStandardOutput $StandardOutput -RedirectStandardError $StandardError -PassThru
$taskProcess.Id
