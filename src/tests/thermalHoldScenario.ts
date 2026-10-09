/**
 * Shared constant for specs that need a scenario known to reach `thermal_hold`.
 *
 * Lives in a plain module (not in a `*.spec.ts`) so specs can import it without importing, and
 * therefore re-running, another spec file. `thermalHoldReachability.spec.ts` is the guard that
 * proves this scenario really enters the hold through the production tick path.
 */

/** The default quick demo. */
export const THERMAL_HOLD_SCENARIO_ID = 'demo_basic'
