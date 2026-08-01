[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string[]]$Path,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedPublisher,

  [switch]$RequireTimestamp
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
  throw 'ExpectedPublisher must name the authorized Windows publisher.'
}

foreach ($candidate in $Path) {
  $resolved = Resolve-Path -LiteralPath $candidate -ErrorAction Stop
  $signature = Get-AuthenticodeSignature -LiteralPath $resolved.Path

  if ($signature.Status -ne 'Valid') {
    throw "Authenticode signature is not valid for $($resolved.Path): $($signature.Status)."
  }
  if (-not $signature.SignerCertificate) {
    throw "No signer certificate was returned for $($resolved.Path)."
  }
  if ($signature.SignerCertificate.Subject -notlike "*$ExpectedPublisher*") {
    throw "Unexpected signer for $($resolved.Path): $($signature.SignerCertificate.Subject). Expected publisher containing '$ExpectedPublisher'."
  }
  if ($RequireTimestamp -and -not $signature.TimeStamperCertificate) {
    throw "No trusted timestamp was found for $($resolved.Path)."
  }

  [pscustomobject]@{
    Path = $resolved.Path
    Status = $signature.Status
    Publisher = $signature.SignerCertificate.Subject
    Thumbprint = $signature.SignerCertificate.Thumbprint
    Timestamped = [bool]$signature.TimeStamperCertificate
  }
}
