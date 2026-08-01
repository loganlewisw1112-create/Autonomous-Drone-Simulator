import type { Pool, PoolClient } from 'pg'

const RECORD_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000

export interface RetentionResult {
  expiredCodes: number
  expiredEntitlements: number
  rateLimits: number
  challenges: number
  auditEvents: number
  installationHistory: number
  codes: number
  entitlements: number
}

async function affected(client: PoolClient, sql: string, parameters: unknown[]): Promise<number> {
  return (await client.query(sql, parameters)).rowCount ?? 0
}

/** Enforces the documented maximum retention without recording deleted identifiers. */
export async function purgeLicensingRetention(pool: Pool, now = new Date()): Promise<RetentionResult> {
  const client = await pool.connect()
  const cutoff = new Date(now.getTime() - RECORD_RETENTION_MS)
  try {
    await client.query('BEGIN')
    const expiredCodes = await affected(client,
      "UPDATE licence_codes SET status = 'expired' WHERE status = 'issued' AND unused_expires_at <= $1",
      [now],
    )
    const expiredEntitlements = await affected(client,
      "UPDATE entitlements SET status = 'expired', updated_at = $1 WHERE status = 'active' AND expires_at <= $1",
      [now],
    )
    const rateLimits = await affected(client,
      'DELETE FROM licensing_rate_limits WHERE expires_at <= $1',
      [now],
    )
    const challenges = await affected(client,
      'DELETE FROM activation_challenges WHERE expires_at <= $1',
      [now],
    )
    const terminalEntitlements = `
      SELECT id FROM entitlements
      WHERE status IN ('expired', 'revoked', 'replacement_pending')
        AND COALESCE(revoked_at, expires_at) <= $1`
    const discardableCodes = `
      SELECT id FROM licence_codes
      WHERE entitlement_id IN (${terminalEntitlements})
         OR replacement_for_entitlement_id IN (${terminalEntitlements})
         OR (entitlement_id IS NULL AND replacement_for_entitlement_id IS NULL AND unused_expires_at <= $1)`
    const auditEvents = await affected(client, `
      DELETE FROM licensing_audit_events
      WHERE entitlement_id IN (${terminalEntitlements})
         OR code_id IN (${discardableCodes})
         OR (entitlement_id IS NULL AND code_id IS NULL AND created_at <= $1)`, [cutoff])
    const installationHistory = await affected(client, `
      DELETE FROM installation_history WHERE entitlement_id IN (${terminalEntitlements})`, [cutoff])
    const codes = await affected(client, `DELETE FROM licence_codes WHERE id IN (${discardableCodes})`, [cutoff])
    const entitlements = await affected(client, `DELETE FROM entitlements WHERE id IN (${terminalEntitlements})`, [cutoff])
    await client.query('COMMIT')
    return {
      expiredCodes,
      expiredEntitlements,
      rateLimits,
      challenges,
      auditEvents,
      installationHistory,
      codes,
      entitlements,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}
