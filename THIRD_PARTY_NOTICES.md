# Third-party notices

The Autonomous Drone Mission Simulator itself is governed by the repository
`LICENSE`. Third-party components remain governed by their own licenses and do
not relicense this project.

This human-readable list identifies principal direct components in the current
application. It is not a complete transitive-license inventory. Every packaged
release must include the machine-generated SBOM and license bundle produced
from the exact lockfile by `npm run sbom`.

| Component | Role | License |
|---|---|---|
| React and React DOM | User interface | MIT |
| Zustand | Local state management | MIT |
| MapLibre GL JS | Tactical map rendering | BSD-3-Clause |
| Recharts | Telemetry charts | MIT |
| `@noble/ciphers`, `@noble/curves`, `@noble/hashes` | Browser cryptography | MIT |
| `@peculiar/x509` and `reflect-metadata` | School-local X.509 certificate generation | MIT / Apache-2.0 |
| `qrcode` | Classroom join QR generation | MIT |
| `ws` | Classroom WebSocket relay | MIT |
| Electron | Optional Windows classroom host | MIT |
| Vite, TypeScript, Vitest, ESLint, Testing Library | Build and test toolchain | Their respective upstream licenses |

Map styles and tiles are requested from OpenFreeMap in the default hosted
experience. Scenario realism fixtures may derive from sources such as ERA5,
FAA UASFM, Terrarium-compatible elevation data, and Overture Maps. Their
provenance manifests and upstream terms apply independently.

Before distribution:

1. Run `npm ci` from the release lockfile.
2. Run `npm run sbom`.
3. Review unknown, non-permissive, dual-license, notice, attribution, font,
   icon, map, and fixture obligations.
4. Bundle required license texts, notices, provenance, and the SBOM beside the
   installer.
5. Record the review and exact Git SHA in the release evidence.

Upstream names and marks belong to their respective owners. Their inclusion
does not imply endorsement, certification, or operational approval.
