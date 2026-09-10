# Workday one-click setup (Windows).
# 1) find a usable Node runtime (runtime\node.exe -> node on PATH -> download)
# 2) start the server
# 3) open the browser
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$runtimeDir = Join-Path $root 'runtime'
$runtimeExe = Join-Path $runtimeDir 'node.exe'
$url = 'http://127.0.0.1:5173/'
$minMajor = 22
$minMinor = 5

function Get-NodeVersion([string]$exe) {
  try {
    $v = (& $exe -v 2>$null)
    if ($v -match '^v(\d+)\.(\d+)\.(\d+)') {
      return [pscustomobject]@{ Major = [int]$Matches[1]; Minor = [int]$Matches[2]; Raw = $v }
    }
  } catch {}
  return $null
}

function Test-Usable([string]$exe) {
  if (-not (Test-Path $exe)) { return $false }
  $v = Get-NodeVersion $exe
  if (-not $v) { return $false }
  return ($v.Major -gt $minMajor) -or ($v.Major -eq $minMajor -and $v.Minor -ge $minMinor)
}

function Find-LocalNode {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $known = @(
    (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
  )
  foreach ($p in $known) { if (Test-Path $p) { return $p } }
  return $null
}

function Install-Runtime([string]$from) {
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  Copy-Item $from $runtimeExe -Force
  Write-Host "runtime ready: $runtimeExe"
}

function Download-Runtime {
  $arch = $env:PROCESSOR_ARCHITECTURE
  if ($arch -eq 'ARM64') { $pkg = 'node-v22.22.2-win-arm64.zip' } else { $pkg = 'node-v22.22.2-win-x64.zip' }
  $dist = "https://nodejs.org/dist/v22.22.2/$pkg"
  $zip = Join-Path $env:TEMP $pkg
  Write-Host "downloading Node runtime (~40MB): $dist"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $dist -OutFile $zip -UseBasicParsing
  $tmp = Join-Path $env:TEMP ("workday-node-" + [guid]::NewGuid().ToString('N'))
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $found = Get-ChildItem -Path $tmp -Recurse -Filter 'node.exe' | Select-Object -First 1
  if (-not $found) { throw 'node.exe not found in downloaded package' }
  Install-Runtime $found.FullName
  Remove-Item $zip -Force -ErrorAction SilentlyContinue
  Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
}

function Test-Server {
  try {
    $r = Invoke-WebRequest -Uri ($url + 'api/health') -UseBasicParsing -TimeoutSec 2 -Proxy 'http://127.0.0.1:1'
    return $r.StatusCode -eq 200
  } catch {
    try {
      $r = Invoke-WebRequest -Uri ($url + 'api/health') -UseBasicParsing -TimeoutSec 2
      return $r.StatusCode -eq 200
    } catch { return $false }
  }
}

Write-Host '=== Workday setup ===' -ForegroundColor Cyan

if (Test-Usable $runtimeExe) {
  Write-Host 'using bundled runtime'
} else {
  $local = Find-LocalNode
  if ($local -and (Test-Usable $local)) {
    Write-Host "copying local node: $local"
    Install-Runtime $local
  } elseif ($local) {
    Write-Host "local node too old: $((Get-NodeVersion $local).Raw) (need >= 22.5)"
    Download-Runtime
  } else {
    Write-Host 'no local node found'
    Download-Runtime
  }
}

if (Test-Server) {
  Write-Host 'server already running'
} else {
  Write-Host 'starting server...'
  Start-Process -FilePath $runtimeExe -ArgumentList ('"' + (Join-Path $root 'server\index.js') + '"') `
    -WorkingDirectory $root -WindowStyle Hidden
  $ok = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 200
    if (Test-Server) { $ok = $true; break }
  }
  if (-not $ok) { Write-Host 'server did not become ready in 12s; run start-server.bat to see logs' -ForegroundColor Red; exit 1 }
}

Write-Host "opening $url"
Start-Process $url
Write-Host 'done. Next time just double-click launch.vbs (or setup.bat).' -ForegroundColor Green
