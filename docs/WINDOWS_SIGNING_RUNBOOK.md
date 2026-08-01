# Windows publisher-signing runbook

## Release requirement

School-pilot installers must be Authenticode-signed by the legal publisher or
an authorized publishing organization and carry a trusted timestamp. A local
self-signed development certificate, an unrelated product certificate, or an
unsigned executable is not releasable.

The repository cannot issue that identity. The legal publisher must obtain a
publicly trusted Windows code-signing certificate or managed signing service
under the approved publisher name and keep private-key access outside the
repository.

## GitHub Actions configuration

Configure these Actions secrets in the repository or protected release
environment:

- `WINDOWS_CSC_LINK` — encrypted certificate material or supported signing
  service reference used by electron-builder;
- `WINDOWS_CSC_KEY_PASSWORD` — certificate password when the selected provider
  requires one;
- `WINDOWS_SIGNER_SUBJECT` — stable expected publisher subject fragment, for
  example the exact legal publisher/organization name.

Restrict secret access to the release environment, require reviewer approval,
and prohibit pull-request workflows from reading signing secrets. Rotate or
revoke credentials after suspected disclosure.

## Qualification

The Windows workflow:

1. re-runs all release gates for the exact SHA;
2. refuses to package without all signing configuration;
3. signs the unpacked application and NSIS installer;
4. verifies `Valid` Authenticode status, expected publisher, and a trusted
   timestamp with `scripts/verify-windows-signature.ps1`;
5. creates SHA-256 checksums, SBOM, provenance attestation, and release files.

Before promotion, install on a clean supported Windows device and independently
inspect Properties > Digital Signatures plus:

```powershell
.\scripts\verify-windows-signature.ps1 `
  -Path '.\Autonomous-Drone-Simulator-Classroom-1.1.0-rc.1-x64.exe' `
  -ExpectedPublisher 'AUTHORIZED PUBLISHER NAME' `
  -RequireTimestamp
```

Record signer subject, thumbprint, timestamp, SHA-256, release SHA, workflow run,
install/uninstall result, and reviewer. A passing local build is not a
substitute for this evidence.
