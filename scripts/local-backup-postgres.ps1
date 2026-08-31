[CmdletBinding()]
param(
  [switch]$Force,
  [ValidateRange(1, 3650)][int]$RetentionDays = 30,
  [ValidatePattern('^(?:[01]\d|2[0-3]):[0-5]\d$')][string]$MinimumDailyTime = '11:00'
)

$ErrorActionPreference = 'Stop'
$ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$DataRoot = 'C:\Users\User\Documents\SEOWebsiteAgent-local-data'
$BackupDirectory = Join-Path $DataRoot 'backups'
$LogDirectory = Join-Path $DataRoot 'logs'
$LockPath = Join-Path $DataRoot 'local-backup.lock'
$StatePath = Join-Path $DataRoot 'latest-backup.json'
$Prefix = 'seo_agent_local_'
$DockerWaitSeconds = 300
$PollSeconds = 5

New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
$LogPath = Join-Path $LogDirectory ('local-backup-{0}.log' -f (Get-Date -Format 'yyyy-MM-dd'))

function Write-BackupLog {
  param([Parameter(Mandatory)][string]$Message)
  Add-Content -LiteralPath $LogPath -Value ('{0} {1}' -f (Get-Date -Format 'o'), $Message)
}

function Write-BackupState {
  param(
    [Parameter(Mandatory)][string]$Status,
    [string]$FileName,
    [long]$SizeBytes = 0,
    [string]$Sha256,
    [string]$Message
  )
  $state = [ordered]@{
    status = $Status
    checkedAt = (Get-Date).ToString('o')
    source = 'LOCAL_POSTGRES_DOCKER'
    fileName = $FileName
    sizeBytes = $SizeBytes
    sha256 = $Sha256
    message = $Message
  }
  $state | ConvertTo-Json | Set-Content -LiteralPath $StatePath -Encoding utf8
}

function Test-GzipArchive {
  param([Parameter(Mandatory)][string]$Path)
  $input = [System.IO.File]::OpenRead($Path)
  try {
    $gzip = [System.IO.Compression.GZipStream]::new(
      $input,
      [System.IO.Compression.CompressionMode]::Decompress
    )
    try {
      $buffer = New-Object byte[] 65536
      $total = 0L
      while (($read = $gzip.Read($buffer, 0, $buffer.Length)) -gt 0) { $total += $read }
      return $total -gt 0
    } finally { $gzip.Dispose() }
  } finally { $input.Dispose() }
}

$lock = $null
$ownsLock = $false
$temporarySql = $null
$temporaryGzip = $null
try {
  try {
    $lock = [System.IO.File]::Open($LockPath, 'OpenOrCreate', 'ReadWrite', 'None')
    $lock.SetLength(0)
    $lockWriter = [System.IO.StreamWriter]::new($lock, [System.Text.UTF8Encoding]::new($false), 1024, $true)
    $lockWriter.Write(("PID={0};STARTED={1}" -f $PID, (Get-Date).ToString('o')))
    $lockWriter.Dispose()
    $lock.Flush()
    $ownsLock = $true
  } catch [System.IO.IOException] {
    Write-BackupLog 'SKIPPED another backup invocation owns the lock.'
    exit 0
  }

  $today = Get-Date -Format 'yyyy-MM-dd'
  $cutoff = [datetime]::ParseExact($MinimumDailyTime, 'HH:mm', $null)
  $now = Get-Date
  if (-not $Force -and $now.TimeOfDay -lt $cutoff.TimeOfDay) {
    Write-BackupLog "SKIPPED before daily backup time $MinimumDailyTime."
    exit 0
  }
  $todayPattern = "${Prefix}${today}T*.sql.gz"
  $validToday = Get-ChildItem -LiteralPath $BackupDirectory -File -Filter $todayPattern |
    Where-Object { $_.Length -gt 0 -and (Test-GzipArchive -Path $_.FullName) } |
    Select-Object -First 1
  if (-not $Force -and $validToday) {
    Write-BackupLog ('SKIPPED valid backup already exists for Bangkok date {0}.' -f $today)
    exit 0
  }

  $dockerDeadline = (Get-Date).AddSeconds($DockerWaitSeconds)
  do {
    & docker info *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds $PollSeconds
  } while ((Get-Date) -lt $dockerDeadline)
  if ($LASTEXITCODE -ne 0) {
    throw "Local Docker engine did not become ready within $DockerWaitSeconds seconds."
  }
  $postgresId = (& docker compose --project-directory $ProjectPath ps -q postgres 2>$null).Trim()
  if (-not $postgresId) { throw 'Local Compose PostgreSQL container is unavailable.' }

  $offset = (Get-Date -Format 'zzz').Replace(':', '')
  $timestamp = '{0}{1}' -f (Get-Date -Format 'yyyy-MM-ddTHHmmss'), $offset
  $fileName = "${Prefix}${timestamp}.sql.gz"
  $finalPath = Join-Path $BackupDirectory $fileName
  $temporarySql = Join-Path $BackupDirectory ('.{0}.{1}.sql.partial' -f $Prefix, [guid]::NewGuid())
  $temporaryGzip = "$finalPath.partial"

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $process.StartInfo.FileName = 'docker'
  $process.StartInfo.UseShellExecute = $false
  $process.StartInfo.RedirectStandardOutput = $true
  $process.StartInfo.RedirectStandardError = $true
  $process.StartInfo.Arguments =
    'exec {0} sh -c "exec pg_dump -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" --no-owner --no-privileges"' -f $postgresId
  if (-not $process.Start()) { throw 'Unable to start local pg_dump.' }
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $dumpFile = [System.IO.File]::Create($temporarySql)
  try { $process.StandardOutput.BaseStream.CopyTo($dumpFile) } finally { $dumpFile.Dispose() }
  $process.WaitForExit()
  $null = $stderrTask.Result
  if ($process.ExitCode -ne 0) { throw "Local pg_dump failed with exit code $($process.ExitCode)." }
  if ((Get-Item -LiteralPath $temporarySql).Length -eq 0) { throw 'Local pg_dump produced an empty file.' }

  $output = [System.IO.FileStream]::new(
    $temporaryGzip,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::Write,
    [System.IO.FileShare]::None
  )
  try {
    $input = [System.IO.File]::OpenRead($temporarySql)
    try {
      $gzip = [System.IO.Compression.GZipStream]::new(
        $output,
        [System.IO.Compression.CompressionLevel]::Optimal
      )
      try { $input.CopyTo($gzip) } finally { $gzip.Dispose() }
    } finally { $input.Dispose() }
  } finally {
    $output.Dispose()
  }
  if (-not (Test-GzipArchive -Path $temporaryGzip)) { throw 'Compressed backup validation failed.' }
  Move-Item -LiteralPath $temporaryGzip -Destination $finalPath
  $temporaryGzip = $null
  Remove-Item -LiteralPath $temporarySql
  $temporarySql = $null

  $backup = Get-Item -LiteralPath $finalPath
  $sha256 = (Get-FileHash -LiteralPath $finalPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath "$finalPath.sha256" -Value ("{0}  {1}" -f $sha256, $fileName) -Encoding ascii
  Write-BackupState -Status 'SUCCESS' -FileName $fileName -SizeBytes $backup.Length -Sha256 $sha256
  Write-BackupLog ('SUCCESS file={0} sizeBytes={1} sha256={2}' -f $fileName, $backup.Length, $sha256)

  $retentionCutoff = (Get-Date).AddDays(-$RetentionDays)
  Get-ChildItem -LiteralPath $BackupDirectory -File -Filter "${Prefix}*.sql.gz" |
    Where-Object { $_.LastWriteTime -lt $retentionCutoff } |
    ForEach-Object {
      $sidecar = "$($_.FullName).sha256"
      Remove-Item -LiteralPath $_.FullName
      if (Test-Path -LiteralPath $sidecar) { Remove-Item -LiteralPath $sidecar }
      Write-BackupLog ('RETENTION removed {0}' -f $_.Name)
    }
  exit 0
} catch {
  Write-BackupState -Status 'FAILED' -Message $_.Exception.Message
  Write-BackupLog ('FAILED {0} STACK {1}' -f $_.Exception.Message, $_.ScriptStackTrace)
  exit 1
} finally {
  if ($temporarySql -and (Test-Path -LiteralPath $temporarySql)) {
    Remove-Item -LiteralPath $temporarySql -Force -ErrorAction SilentlyContinue
  }
  if ($temporaryGzip -and (Test-Path -LiteralPath $temporaryGzip)) {
    Remove-Item -LiteralPath $temporaryGzip -Force -ErrorAction SilentlyContinue
  }
  if ($lock) { $lock.Dispose() }
  if ($ownsLock) { Remove-Item -LiteralPath $LockPath -Force -ErrorAction SilentlyContinue }
}
