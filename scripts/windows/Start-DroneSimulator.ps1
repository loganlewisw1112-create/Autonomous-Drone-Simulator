param(
  [switch]$NoBrowser,
  [int]$PortStart = 4173
)

$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $PSScriptRoot
$AppRoot = Join-Path $PackageRoot 'app'
$IndexPath = Join-Path $AppRoot 'index.html'

if (-not (Test-Path -LiteralPath $IndexPath)) {
  throw "Cannot find app\index.html. Extract the full zip before launching."
}

$AppRootFull = [System.IO.Path]::GetFullPath($AppRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar

# Runtime state (URL/PID marker files) goes to a temp rundir, NOT the package tree —
# the shipped folder stays pristine and re-zippable (M16).
$RunDir = Join-Path ([System.IO.Path]::GetTempPath()) "drone-simulator-$PID"
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

function Get-MimeType {
  param([string]$Path)
  switch ([System.IO.Path]::GetExtension($Path).ToLowerInvariant()) {
    '.html' { 'text/html; charset=utf-8'; break }
    '.js' { 'text/javascript; charset=utf-8'; break }
    '.css' { 'text/css; charset=utf-8'; break }
    '.svg' { 'image/svg+xml'; break }
    '.json' { 'application/json; charset=utf-8'; break }
    '.map' { 'application/json; charset=utf-8'; break }
    '.txt' { 'text/plain; charset=utf-8'; break }
    default { 'application/octet-stream'; break }
  }
}

function Send-Response {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$ContentType,
    [byte[]]$Body
  )
  $header = "HTTP/1.1 $StatusCode $StatusText`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $Stream.Write($headerBytes, 0, $headerBytes.Length)
  if ($Body.Length -gt 0) {
    $Stream.Write($Body, 0, $Body.Length)
  }
}

function Send-Text {
  param(
    [System.Net.Sockets.NetworkStream]$Stream,
    [int]$StatusCode,
    [string]$StatusText,
    [string]$Text
  )
  $body = [System.Text.Encoding]::UTF8.GetBytes($Text)
  Send-Response -Stream $Stream -StatusCode $StatusCode -StatusText $StatusText -ContentType 'text/plain; charset=utf-8' -Body $body
}

$listener = $null
$selectedPort = $null
for ($port = $PortStart; $port -le ($PortStart + 100); $port++) {
  try {
    $candidate = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $port)
    $candidate.Start()
    $listener = $candidate
    $selectedPort = $port
    break
  } catch {
    if ($candidate) { $candidate.Stop() }
  }
}

if (-not $listener) {
  throw "No available localhost port found from $PortStart to $($PortStart + 100)."
}

$url = "http://127.0.0.1:$selectedPort/"
Set-Content -LiteralPath (Join-Path $RunDir 'server-url.txt') -Value $url -Encoding ASCII
Set-Content -LiteralPath (Join-Path $RunDir 'server.pid') -Value $PID -Encoding ASCII

Write-Host "Autonomous Drone Simulator"
Write-Host "Serving from: $AppRoot"
Write-Host "Open: $url"
Write-Host "Press Ctrl+C to stop."

if (-not $NoBrowser -and $env:DRONE_SIMULATOR_NO_BROWSER -ne '1') {
  Start-Process $url
}

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)
      $requestLine = $reader.ReadLine()
      if ([string]::IsNullOrWhiteSpace($requestLine)) {
        Send-Text -Stream $stream -StatusCode 400 -StatusText 'Bad Request' -Text 'Bad Request'
        continue
      }
      while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line.Length -eq 0) { break }
      }

      $parts = $requestLine.Split(' ')
      if ($parts.Length -lt 2 -or $parts[0] -ne 'GET') {
        Send-Text -Stream $stream -StatusCode 405 -StatusText 'Method Not Allowed' -Text 'Only GET is supported.'
        continue
      }

      $pathOnly = ($parts[1] -split '\?')[0]
      $decodedPath = [System.Uri]::UnescapeDataString($pathOnly)
      if ($decodedPath -eq '/' -or [string]::IsNullOrWhiteSpace($decodedPath)) {
        $decodedPath = '/index.html'
      }
      $relativePath = $decodedPath.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
      $candidatePath = [System.IO.Path]::GetFullPath((Join-Path $AppRoot $relativePath))

      if (-not $candidatePath.StartsWith($AppRootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
        Send-Text -Stream $stream -StatusCode 403 -StatusText 'Forbidden' -Text 'Forbidden'
        continue
      }

      if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
        if ([string]::IsNullOrEmpty([System.IO.Path]::GetExtension($candidatePath))) {
          $candidatePath = $IndexPath
        } else {
          Send-Text -Stream $stream -StatusCode 404 -StatusText 'Not Found' -Text 'Not Found'
          continue
        }
      }

      $bytes = [System.IO.File]::ReadAllBytes($candidatePath)
      Send-Response -Stream $stream -StatusCode 200 -StatusText 'OK' -ContentType (Get-MimeType $candidatePath) -Body $bytes
    } catch {
      # Never echo exception details to the client (M16) — log locally, return a generic body.
      Write-Warning "Request failed: $($_.Exception.Message)"
      try { Send-Text -Stream $stream -StatusCode 500 -StatusText 'Server Error' -Text 'Internal Server Error' } catch {}
    } finally {
      if ($reader) { $reader.Dispose() }
      if ($stream) { $stream.Dispose() }
      $client.Close()
    }
  }
} finally {
  if ($listener) { $listener.Stop() }
  Remove-Item -LiteralPath $RunDir -Recurse -Force -ErrorAction SilentlyContinue
}
