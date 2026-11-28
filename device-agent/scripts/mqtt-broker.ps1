# Device Agent local MQTT broker helper (mosquitto 2.x)
#
# Why a project-managed broker on port 1884 instead of the installed service on 1883:
#   The mosquitto installer registers a Windows service running as SYSTEM which
#   listens on 127.0.0.1:1883. Stopping it requires UAC/admin. This project does
#   not depend on that service; a dedicated port keeps runs reproducible without
#   elevated rights.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\mqtt-broker.ps1 start
#   powershell -ExecutionPolicy Bypass -File scripts\mqtt-broker.ps1 stop
#   powershell -ExecutionPolicy Bypass -File scripts\mqtt-broker.ps1 status
#
# IMPORTANT: keep this file ASCII-only.
#   Windows PowerShell 5.1 parses .ps1 as ANSI unless the file has a UTF-8 BOM,
#   so any non-ASCII literal (including Chinese comments) can break the parser.

param(
  [Parameter(Position = 0)]
  [ValidateSet('start', 'stop', 'status', 'restart')]
  [string]$Action = 'status',

  [string]$MosquittoDir = 'D:\dsh\bianyuan\mosquitto',
  [int]$Port = 1884
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $MosquittoDir 'mosquitto.exe'
$conf = Join-Path $root 'config\mosquitto.conf'
$stateDir = Join-Path $root '.device_agent'
$pidFile = Join-Path $stateDir 'mosquitto.pid'
$logDir = Join-Path $stateDir 'logs'
$logFile = Join-Path $logDir 'mosquitto.log'

function Get-BrokerProcess {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $savedId = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if (-not $savedId) { return $null }
  return Get-Process -Id ([int]$savedId) -ErrorAction SilentlyContinue
}

function Test-PortBusy {
  $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  return [bool]$conn
}

function Start-Broker {
  if (-not (Test-Path -LiteralPath $exe)) {
    throw "mosquitto.exe not found: $exe (install mosquitto 2.x first)"
  }
  if (-not (Test-Path -LiteralPath $conf)) {
    throw "config not found: $conf"
  }
  if (Test-PortBusy) {
    $owner = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty OwningProcess
    Write-Output "port $Port already in use (pid=$owner)"
    return
  }
  New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null

  # Launching a long-lived broker as a plain child process is not enough:
  # many automation hosts wait for the whole process tree to exit. Use WMI
  # Win32_Process.Create so the broker is owned by the WMI provider and fully
  # detached from this script's process tree.
  $cmdLine = 'cmd.exe /c ""' + $exe + '" -c "' + $conf + '" -v > "' + $logFile + '" 2>&1"'
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create `
    -Arguments @{ CommandLine = $cmdLine; CurrentDirectory = $root }
  if ($created.ReturnValue -ne 0) {
    throw "Win32_Process.Create failed with $($created.ReturnValue)"
  }
  $procId = [int]$created.ProcessId
  Set-Content -LiteralPath $pidFile -Value $procId -Encoding ascii
  Start-Sleep -Milliseconds 1500
  $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
  if ($null -eq $proc) {
    Write-Output "broker failed to start; see $logFile"
    return
  }
  Write-Output "mosquitto started: pid=$procId port=$Port"
}

function Stop-Broker {
  $proc = Get-BrokerProcess
  if ($null -eq $proc) {
    Write-Output 'no project-managed broker running'
    if (Test-Path -LiteralPath $pidFile) { Remove-Item -LiteralPath $pidFile -Force }
    return
  }
  $proc.Kill()
  $proc.WaitForExit(3000) | Out-Null
  Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  Write-Output "mosquitto stopped: pid=$($proc.Id)"
}

function Show-Status {
  $proc = Get-BrokerProcess
  if ($null -eq $proc) {
    Write-Output 'project broker: stopped'
  } else {
    Write-Output "project broker: running pid=$($proc.Id)"
  }
  $listen = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($listen) {
    $listen | ForEach-Object { Write-Output ("  listening " + $_.LocalAddress + ":" + $_.LocalPort) }
  } else {
    Write-Output "  port $Port has no listener"
  }
}

switch ($Action) {
  'start'   { Start-Broker }
  'stop'    { Stop-Broker }
  'restart' { Stop-Broker; Start-Sleep -Milliseconds 500; Start-Broker }
  'status'  { Show-Status }
}
