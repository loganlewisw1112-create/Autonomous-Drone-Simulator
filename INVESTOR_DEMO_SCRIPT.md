# Investor Demo Script

## Preflight

Run these checks before showing the simulator:

```bash
npm test
npm run build
npm run dev
```

Open `http://127.0.0.1:5173/`.

## Demo Flow

1. Load `USCG Coastal SAR` (`demo_sar_coastal`).
2. Turn on `DEMO MODE` in the bottom control bar.
3. Complete preflight and launch bay planning.
4. Start the mission and select one drone from the fleet.
5. Drag a yellow route marker to show validated waypoint editing and autosave.
6. Open OPS HUB, click `SUGGEST`, then accept or reject a generated route.
7. Open the right-side `READY` tab and explain mission outcome, compliance readiness, and UTM traffic.
8. Switch to IR / Thermal, select a contact, and dispatch or resolve it.
9. Stop the mission, enter replay, and export the after-action report.
10. Click `DEMO RESET` before the next audience or take.

## Investor Talking Points

- The simulator demonstrates operator-supervised autonomy, not black-box flight.
- Route edits are validated before autosave, so unsafe mission drafts do not persist.
- The readiness tab translates technical state into investor-readable outcomes.
- Compliance and UTM layers show where real integrations would attach later without pretending this local demo is operational authorization.
- The after-action package proves the platform can produce evidence, KPIs, and replay-linked review artifacts.
