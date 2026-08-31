[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DataRoot = 'C:\Users\User\Documents\SEOWebsiteAgent-local-data'
$LogDirectory = Join-Path $DataRoot 'logs'
$DockerDesktopPath = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$DockerWaitSeconds = 300
$HealthWaitSeconds = 120
$PollSeconds = 5

New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogPath = Join-Path $LogDirectory ('local-start-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-LocalLog {
  param([Parameter(Mandatory)][string]$Message)
  Add-Content -LiteralPath $LogPath -Value ('{0} {1}' -f (Get-Date -Format 'o'), $Message)
}

function Test-DockerEngine {
  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Get-ServiceContainerId {
  param([Parameter(Mandatory)][string]$Service)
  return (& docker compose --project-directory $ProjectPath ps -q $Service 2>$null).Trim()
}

function Test-ServiceHealthy {
  param([Parameter(Mandatory)][string]$Service)
  $containerId = Get-ServiceContainerId -Service $Service
  if (-not $containerId) { return $false }
  $state = (& docker inspect --format '{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' $containerId 2>$null).Trim()
  return $LASTEXITCODE -eq 0 -and $state -in @('running|healthy', 'running|none')
}

try {
  Write-LocalLog 'START requested.'
  if (-not (Test-DockerEngine)) {
    if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
      if (-not (Test-Path -LiteralPath $DockerDesktopPath)) {
        throw 'Docker Desktop is not installed at the expected path.'
      }
      Start-Process -FilePath $DockerDesktopPath -WindowStyle Hidden
      Write-LocalLog 'Docker Desktop launch requested.'
    }

    $deadline = (Get-Date).AddSeconds($DockerWaitSeconds)
    while ((Get-Date) -lt $deadline -and -not (Test-DockerEngine)) {
      Start-Sleep -Seconds $PollSeconds
    }
    if (-not (Test-DockerEngine)) {
      throw "Docker engine did not become ready within $DockerWaitSeconds seconds."
    }
  }
  Write-LocalLog 'Docker engine is ready.'

  $previousErrorPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & docker compose --project-directory $ProjectPath up -d --no-build 2>&1 |
    Out-File -LiteralPath $LogPath -Append -Encoding utf8
  $composeExitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorPreference
  if ($composeExitCode -ne 0) { throw 'docker compose up failed.' }

  $healthDeadline = (Get-Date).AddSeconds($HealthWaitSeconds)
  do {
    $postgresHealthy = Test-ServiceHealthy -Service 'postgres'
    $webHealthy = Test-ServiceHealthy -Service 'web'
    $workerHealthy = Test-ServiceHealthy -Service 'worker'
    if ($postgresHealthy -and $webHealthy -and $workerHealthy) { break }
    Start-Sleep -Seconds $PollSeconds
  } while ((Get-Date) -lt $healthDeadline)

  if (-not ($postgresHealthy -and $webHealthy -and $workerHealthy)) {
    throw "Local services did not become healthy within $HealthWaitSeconds seconds."
  }
  Write-LocalLog 'SUCCESS postgres=healthy web=healthy worker=healthy.'
  exit 0
} catch {
  Write-LocalLog ('FAILED {0}' -f $_.Exception.Message)
  exit 1
}
