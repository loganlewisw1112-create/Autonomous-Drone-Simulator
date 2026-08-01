import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import type { EntitlementTier } from './contracts.js'
import { LicensingError } from './contracts.js'

export interface EntitlementRecord {
  id: string
  tier: EntitlementTier
  status: 'active' | 'replacement_pending' | 'revoked' | 'expired'
  installationKeyThumbprint: string | null
  activatedAt: Date
  expiresAt: Date
  leaseSerial: number
  replacementCount: number
  minimumVersion: string
  maximumVersionExclusive: string
}

export interface CodeRecord {
  id: string
  tier: EntitlementTier
  status: 'issued' | 'consumed' | 'expired' | 'revoked'
  entitlementId: string | null
  replacementForEntitlementId: string | null
  unusedExpiresAt: Date
  createdAt: Date
  consumedAt: Date | null
}

export interface ChallengeInput {
  id: string
  digest: Buffer
  installationKeyThumbprint: string
  purpose: 'activation' | 'refresh'
  expiresAt: Date
}

export interface ChallengeUse {
  id: string
  digest: Buffer
  installationKeyThumbprint: string
  purpose: 'activation' | 'refresh'
  now: Date
}

export interface IssueCodeInput {
  id: string
  digest: Buffer
  tier: EntitlementTier
  recipientRefHash: string | null
  unusedExpiresAt: Date
  replacementForEntitlementId?: string
  actorPseudonym: string
  now: Date
}

export interface RedeemCodeInput {
  challenge: ChallengeUse
  codeDigest: Buffer
  entitlementId: string
  installationHistoryId: string
  tierDurationsMs: Readonly<Record<EntitlementTier, number>>
  minimumVersion: string
  maximumVersionExclusive: string
  actorPseudonym: string
}

export interface RefreshInput {
  challenge: ChallengeUse
  entitlementId: string
  actorPseudonym: string
}

export interface LicensingRepository {
  createChallenge(input: ChallengeInput): Promise<void>
  issueCode(input: IssueCodeInput): Promise<CodeRecord>
  redeemCode(input: RedeemCodeInput): Promise<EntitlementRecord>
  refreshEntitlement(input: RefreshInput): Promise<EntitlementRecord>
  consumeRateLimit(
    subjectPseudonym: string,
    action: string,
    limit: number,
    windowMs: number,
    now: Date,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }>
  getCodeByDigest(digest: Buffer): Promise<CodeRecord | null>
  getEntitlement(id: string): Promise<EntitlementRecord | null>
  revokeEntitlement(id: string, reason: string, actorPseudonym: string, now: Date): Promise<EntitlementRecord>
  replaceEntitlement(
    id: string,
    code: Omit<IssueCodeInput, 'replacementForEntitlementId'>,
    reason: string,
  ): Promise<{ entitlement: EntitlementRecord; code: CodeRecord }>
  promoteEntitlement(
    id: string,
    tier: 'agency_classroom_pilot',
    actorPseudonym: string,
    now: Date,
    durationMs: number,
    reason: string,
  ): Promise<EntitlementRecord>
}

interface DbEntitlementRow {
  id: string
  tier: EntitlementTier
  status: EntitlementRecord['status']
  installation_key_thumbprint: string | null
  activated_at: Date
  expires_at: Date
  lease_serial: number
  replacement_count: number
  minimum_version: string
  maximum_version_exclusive: string
}

interface DbCodeRow {
  id: string
  tier: EntitlementTier
  status: CodeRecord['status']
  entitlement_id: string | null
  replacement_for_entitlement_id: string | null
  unused_expires_at: Date
  created_at: Date
  consumed_at: Date | null
}

function entitlementFromRow(row: DbEntitlementRow): EntitlementRecord {
  return {
    id: row.id,
    tier: row.tier,
    status: row.status,
    installationKeyThumbprint: row.installation_key_thumbprint,
    activatedAt: row.activated_at,
    expiresAt: row.expires_at,
    leaseSerial: row.lease_serial,
    replacementCount: row.replacement_count,
    minimumVersion: row.minimum_version,
    maximumVersionExclusive: row.maximum_version_exclusive,
  }
}

function codeFromRow(row: DbCodeRow): CodeRecord {
  return {
    id: row.id,
    tier: row.tier,
    status: row.status,
    entitlementId: row.entitlement_id,
    replacementForEntitlementId: row.replacement_for_entitlement_id,
    unusedExpiresAt: row.unused_expires_at,
    createdAt: row.created_at,
    consumedAt: row.consumed_at,
  }
}

function unavailableCode(): never {
  throw new LicensingError('code-unavailable', 'The code is invalid, expired, or already used.', 409)
}

export class PostgresLicensingRepository implements LicensingRepository {
  constructor(private readonly pool: Pool) {}

  private async serializable<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const client = await this.pool.connect()
      try {
        await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE')
        const result = await work(client)
        await client.query('COMMIT')
        return result
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined)
        if ((error as { code?: string }).code === '40001' && attempt < 3) continue
        throw error
      } finally {
        client.release()
      }
    }
    throw new Error('Serializable transaction retry exhausted')
  }

  async createChallenge(input: ChallengeInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO activation_challenges
       (id, challenge_digest, installation_key_thumbprint, purpose, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.id, input.digest, input.installationKeyThumbprint, input.purpose, input.expiresAt],
    )
  }

  async issueCode(input: IssueCodeInput): Promise<CodeRecord> {
    const result = await this.pool.query<DbCodeRow>(
      `WITH inserted AS (
         INSERT INTO licence_codes
           (id, code_digest, tier, status, recipient_ref_hash, unused_expires_at,
            replacement_for_entitlement_id)
         VALUES ($1, $2, $3, 'issued', $4, $5, $6)
         RETURNING *
       ), audited AS (
         INSERT INTO licensing_audit_events
           (id, event_type, code_id, actor_pseudonym, details, created_at)
         SELECT $7, 'code.issued', id, $8, jsonb_build_object('tier', tier), $9 FROM inserted
       )
       SELECT * FROM inserted`,
      [
        input.id,
        input.digest,
        input.tier,
        input.recipientRefHash,
        input.unusedExpiresAt,
        input.replacementForEntitlementId ?? null,
        randomUUID(),
        input.actorPseudonym,
        input.now,
      ],
    )
    return codeFromRow(result.rows[0]!)
  }

  private async consumeChallenge(client: PoolClient, input: ChallengeUse): Promise<void> {
    const result = await client.query<{
      challenge_digest: Buffer
      installation_key_thumbprint: string
      purpose: ChallengeUse['purpose']
      expires_at: Date
      consumed_at: Date | null
    }>(
      `SELECT challenge_digest, installation_key_thumbprint, purpose, expires_at, consumed_at
       FROM activation_challenges WHERE id = $1 FOR UPDATE`,
      [input.id],
    )
    const row = result.rows[0]
    if (
      !row || row.consumed_at || row.expires_at.getTime() <= input.now.getTime() ||
      !row.challenge_digest.equals(input.digest) ||
      row.installation_key_thumbprint !== input.installationKeyThumbprint ||
      row.purpose !== input.purpose
    ) {
      throw new LicensingError('invalid-proof', 'Challenge is invalid, expired, or already used.', 401)
    }
    await client.query('UPDATE activation_challenges SET consumed_at = $2 WHERE id = $1', [input.id, input.now])
  }

  async redeemCode(input: RedeemCodeInput): Promise<EntitlementRecord> {
    return this.serializable(async (client) => {
      await this.consumeChallenge(client, input.challenge)
      const codeResult = await client.query<DbCodeRow>(
        'SELECT * FROM licence_codes WHERE code_digest = $1 FOR UPDATE',
        [input.codeDigest],
      )
      const code = codeResult.rows[0]
      if (!code) return unavailableCode()

      if (code.status === 'consumed' && code.entitlement_id) {
        const retry = await client.query<DbEntitlementRow>(
          'SELECT * FROM entitlements WHERE id = $1 FOR UPDATE',
          [code.entitlement_id],
        )
        const existing = retry.rows[0]
        if (
          existing?.status === 'active' &&
          existing.installation_key_thumbprint === input.challenge.installationKeyThumbprint &&
          existing.expires_at.getTime() > input.challenge.now.getTime()
        ) {
          const refreshed = await client.query<DbEntitlementRow>(
            `UPDATE entitlements SET lease_serial = lease_serial + 1, updated_at = $2
             WHERE id = $1 RETURNING *`,
            [existing.id, input.challenge.now],
          )
          return entitlementFromRow(refreshed.rows[0]!)
        }
        return unavailableCode()
      }

      if (code.status !== 'issued' || code.unused_expires_at.getTime() <= input.challenge.now.getTime()) {
        if (code.status === 'issued') {
          await client.query("UPDATE licence_codes SET status = 'expired' WHERE id = $1", [code.id])
        }
        return unavailableCode()
      }

      const historicalInstall = await client.query(
        'SELECT 1 FROM installation_history WHERE installation_key_thumbprint = $1',
        [input.challenge.installationKeyThumbprint],
      )
      if (historicalInstall.rowCount) return unavailableCode()

      let entitlement: EntitlementRecord
      if (code.replacement_for_entitlement_id) {
        const replacementResult = await client.query<DbEntitlementRow>(
          'SELECT * FROM entitlements WHERE id = $1 FOR UPDATE',
          [code.replacement_for_entitlement_id],
        )
        const replacement = replacementResult.rows[0]
        if (
          !replacement || replacement.status !== 'replacement_pending' ||
          replacement.replacement_count !== 1 ||
          replacement.expires_at.getTime() <= input.challenge.now.getTime()
        ) return unavailableCode()
        const updated = await client.query<DbEntitlementRow>(
          `UPDATE entitlements
           SET status = 'active', installation_key_thumbprint = $2,
               lease_serial = lease_serial + 1, updated_at = $3
           WHERE id = $1 RETURNING *`,
          [replacement.id, input.challenge.installationKeyThumbprint, input.challenge.now],
        )
        entitlement = entitlementFromRow(updated.rows[0]!)
      } else {
        const activatedAt = input.challenge.now
        const expiresAt = new Date(activatedAt.getTime() + input.tierDurationsMs[code.tier])
        const inserted = await client.query<DbEntitlementRow>(
          `INSERT INTO entitlements
             (id, tier, status, installation_key_thumbprint, activated_at, expires_at,
              minimum_version, maximum_version_exclusive)
           VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            input.entitlementId,
            code.tier,
            input.challenge.installationKeyThumbprint,
            activatedAt,
            expiresAt,
            input.minimumVersion,
            input.maximumVersionExclusive,
          ],
        )
        entitlement = entitlementFromRow(inserted.rows[0]!)
      }

      await client.query(
        `INSERT INTO installation_history
           (id, entitlement_id, installation_key_thumbprint, activated_at)
         VALUES ($1, $2, $3, $4)`,
        [
          input.installationHistoryId,
          entitlement.id,
          input.challenge.installationKeyThumbprint,
          input.challenge.now,
        ],
      )
      await client.query(
        `UPDATE licence_codes
         SET status = 'consumed', entitlement_id = $2, consumed_at = $3
         WHERE id = $1`,
        [code.id, entitlement.id, input.challenge.now],
      )
      await client.query(
        `INSERT INTO licensing_audit_events
           (id, event_type, entitlement_id, code_id, actor_pseudonym, details, created_at)
         VALUES ($1, 'entitlement.activated', $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          entitlement.id,
          code.id,
          input.actorPseudonym,
          JSON.stringify({ tier: entitlement.tier, replacement: Boolean(code.replacement_for_entitlement_id) }),
          input.challenge.now,
        ],
      )
      return entitlement
    })
  }

  async refreshEntitlement(input: RefreshInput): Promise<EntitlementRecord> {
    return this.serializable(async (client) => {
      await this.consumeChallenge(client, input.challenge)
      const result = await client.query<DbEntitlementRow>(
        'SELECT * FROM entitlements WHERE id = $1 FOR UPDATE',
        [input.entitlementId],
      )
      const row = result.rows[0]
      if (!row || row.installation_key_thumbprint !== input.challenge.installationKeyThumbprint) {
        throw new LicensingError('invalid-proof', 'Entitlement does not match this installation.', 401)
      }
      if (row.status === 'revoked' || row.status === 'replacement_pending') {
        throw new LicensingError('revoked', 'This entitlement is no longer active.', 403)
      }
      if (row.status === 'expired' || row.expires_at.getTime() <= input.challenge.now.getTime()) {
        if (row.status !== 'expired') {
          await client.query("UPDATE entitlements SET status = 'expired', updated_at = $2 WHERE id = $1", [row.id, input.challenge.now])
        }
        throw new LicensingError('expired', 'This entitlement has expired.', 403)
      }
      const updated = await client.query<DbEntitlementRow>(
        `UPDATE entitlements SET lease_serial = lease_serial + 1, updated_at = $2
         WHERE id = $1 RETURNING *`,
        [row.id, input.challenge.now],
      )
      await client.query(
        `INSERT INTO licensing_audit_events
           (id, event_type, entitlement_id, actor_pseudonym, created_at)
         VALUES ($1, 'lease.refreshed', $2, $3, $4)`,
        [randomUUID(), row.id, input.actorPseudonym, input.challenge.now],
      )
      return entitlementFromRow(updated.rows[0]!)
    })
  }

  async consumeRateLimit(
    subjectPseudonym: string,
    action: string,
    limit: number,
    windowMs: number,
    now: Date,
  ): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const result = await this.pool.query<{ attempt_count: number; window_started_at: Date }>(
      `INSERT INTO licensing_rate_limits
         (subject_pseudonym, action, window_started_at, attempt_count, expires_at)
       VALUES ($1, $2, $3, 1, $4)
       ON CONFLICT (subject_pseudonym, action) DO UPDATE SET
         window_started_at = CASE
           WHEN licensing_rate_limits.window_started_at <= $3 - ($5::bigint * interval '1 millisecond')
           THEN $3 ELSE licensing_rate_limits.window_started_at END,
         attempt_count = CASE
           WHEN licensing_rate_limits.window_started_at <= $3 - ($5::bigint * interval '1 millisecond')
           THEN 1 ELSE licensing_rate_limits.attempt_count + 1 END,
         expires_at = $4
       RETURNING attempt_count, window_started_at`,
      [subjectPseudonym, action, now, new Date(now.getTime() + windowMs), windowMs],
    )
    const row = result.rows[0]!
    const retryAfterSeconds = Math.max(1, Math.ceil((row.window_started_at.getTime() + windowMs - now.getTime()) / 1_000))
    return { allowed: row.attempt_count <= limit, retryAfterSeconds }
  }

  async getCodeByDigest(digest: Buffer): Promise<CodeRecord | null> {
    const result = await this.pool.query<DbCodeRow>('SELECT * FROM licence_codes WHERE code_digest = $1', [digest])
    return result.rows[0] ? codeFromRow(result.rows[0]) : null
  }

  async getEntitlement(id: string): Promise<EntitlementRecord | null> {
    const result = await this.pool.query<DbEntitlementRow>('SELECT * FROM entitlements WHERE id = $1', [id])
    return result.rows[0] ? entitlementFromRow(result.rows[0]) : null
  }

  async revokeEntitlement(id: string, reason: string, actorPseudonym: string, now: Date): Promise<EntitlementRecord> {
    return this.serializable(async (client) => {
      const result = await client.query<DbEntitlementRow>(
        `UPDATE entitlements SET status = 'revoked', installation_key_thumbprint = NULL,
           revoked_at = $2, revoked_reason = $3, lease_serial = lease_serial + 1, updated_at = $2
         WHERE id = $1 AND status IN ('active', 'replacement_pending') RETURNING *`,
        [id, now, reason],
      )
      if (!result.rows[0]) throw new LicensingError('not-found', 'Active entitlement was not found.', 404)
      await client.query(
        `UPDATE installation_history SET deactivated_at = $2, deactivation_reason = 'revoked'
         WHERE entitlement_id = $1 AND deactivated_at IS NULL`,
        [id, now],
      )
      await client.query(
        `INSERT INTO licensing_audit_events
         (id, event_type, entitlement_id, actor_pseudonym, details, created_at)
         VALUES ($1, 'entitlement.revoked', $2, $3, $4, $5)`,
        [randomUUID(), id, actorPseudonym, JSON.stringify({ reason }), now],
      )
      return entitlementFromRow(result.rows[0])
    })
  }

  async replaceEntitlement(
    id: string,
    code: Omit<IssueCodeInput, 'replacementForEntitlementId'>,
    reason: string,
  ): Promise<{ entitlement: EntitlementRecord; code: CodeRecord }> {
    return this.serializable(async (client) => {
      const selected = await client.query<DbEntitlementRow>(
        'SELECT * FROM entitlements WHERE id = $1 FOR UPDATE',
        [id],
      )
      const current = selected.rows[0]
      if (
        !current || current.status !== 'active' || current.replacement_count >= 1 ||
        current.expires_at.getTime() <= code.now.getTime()
      ) {
        throw new LicensingError('replacement-unavailable', 'Entitlement is not eligible for replacement.', 409)
      }
      await client.query(
        `UPDATE installation_history SET deactivated_at = $2, deactivation_reason = 'replaced'
         WHERE entitlement_id = $1 AND deactivated_at IS NULL`,
        [id, code.now],
      )
      const updated = await client.query<DbEntitlementRow>(
        `UPDATE entitlements SET status = 'replacement_pending', installation_key_thumbprint = NULL,
           replacement_count = replacement_count + 1, lease_serial = lease_serial + 1, updated_at = $2
         WHERE id = $1 RETURNING *`,
        [id, code.now],
      )
      const inserted = await client.query<DbCodeRow>(
        `INSERT INTO licence_codes
          (id, code_digest, tier, status, recipient_ref_hash, unused_expires_at,
           replacement_for_entitlement_id)
         VALUES ($1, $2, $3, 'issued', $4, $5, $6) RETURNING *`,
        [code.id, code.digest, current.tier, code.recipientRefHash, code.unusedExpiresAt, id],
      )
      await client.query(
        `INSERT INTO licensing_audit_events
         (id, event_type, entitlement_id, code_id, actor_pseudonym, details, created_at)
         VALUES ($1, 'entitlement.replacement-issued', $2, $3, $4, $5, $6)`,
        [randomUUID(), id, code.id, code.actorPseudonym, JSON.stringify({ preservesExpiry: true, reason }), code.now],
      )
      return { entitlement: entitlementFromRow(updated.rows[0]!), code: codeFromRow(inserted.rows[0]!) }
    })
  }

  async promoteEntitlement(
    id: string,
    tier: 'agency_classroom_pilot',
    actorPseudonym: string,
    now: Date,
    durationMs: number,
    reason: string,
  ): Promise<EntitlementRecord> {
    return this.serializable(async (client) => {
      const result = await client.query<DbEntitlementRow>(
        `UPDATE entitlements SET tier = $2, activated_at = $3, expires_at = $4,
           lease_serial = lease_serial + 1, updated_at = $3
         WHERE id = $1 AND status = 'active' AND tier = 'selected_evaluator_demo'
         RETURNING *`,
        [id, tier, now, new Date(now.getTime() + durationMs)],
      )
      if (!result.rows[0]) throw new LicensingError('promotion-unavailable', 'Entitlement is not eligible for promotion.', 409)
      await client.query(
        `INSERT INTO licensing_audit_events
         (id, event_type, entitlement_id, actor_pseudonym, details, created_at)
         VALUES ($1, 'entitlement.promoted', $2, $3, $4, $5)`,
        [randomUUID(), id, actorPseudonym, JSON.stringify({ tier, reason }), now],
      )
      return entitlementFromRow(result.rows[0])
    })
  }
}
