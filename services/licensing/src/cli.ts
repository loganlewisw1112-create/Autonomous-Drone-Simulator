#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { loadConfig } from './config.js'
import {
  TIER_DURATION_MS,
  UNUSED_CODE_TTL_MS,
  type EntitlementTier,
  LicensingError,
} from './contracts.js'
import { generateRedemptionCode, hmacDigest, normalizeCode, pseudonym } from './crypto.js'
import { migrate } from './migrate.js'
import { PostgresLicensingRepository } from './repository.js'
import { purgeLicensingRetention } from './retention.js'

type Args = Record<string, string | boolean>

function parseArgs(values: string[]): { command: string; flags: Args } {
  const [command = 'help', ...rest] = values
  const flags: Args = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`)
    const key = token.slice(2)
    const next = rest[index + 1]
    if (!next || next.startsWith('--')) flags[key] = true
    else {
      flags[key] = next
      index += 1
    }
  }
  return { command, flags }
}

function flag(flags: Args, name: string, maximum = 256): string {
  const value = flags[name]
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`--${name} is required and must be at most ${maximum} characters`)
  }
  return value.trim()
}

function optionalFlag(flags: Args, name: string, maximum = 256): string | null {
  const value = flags[name]
  if (value === undefined) return null
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw new Error(`--${name} must be at most ${maximum} characters`)
  }
  return value.trim()
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function help(): void {
  process.stdout.write(`ADMS publisher licensing CLI\n\n`)
  process.stdout.write(`  migrate\n`)
  process.stdout.write(`  issue --tier evaluator|pilot --recipient-ref <pseudonym>\n`)
  process.stdout.write(`  status --code <redemption-code> | --license <licence-id>\n`)
  process.stdout.write(`  revoke --license <licence-id> --reason <text>\n`)
  process.stdout.write(`  replace --license <licence-id> --reason <text>\n`)
  process.stdout.write(`  promote --license <licence-id> --tier pilot --reason <text>\n`)
  process.stdout.write(`  purge-retention --confirm PURGE\n`)
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2))
  if (command === 'help' || command === '--help') {
    help()
    return
  }
  if (command === 'migrate') {
    const databaseUrl = process.env.DATABASE_URL?.trim()
    if (!databaseUrl) throw new Error('DATABASE_URL is required')
    output({ applied: await migrate(databaseUrl) })
    return
  }
  if (command === 'purge-retention') {
    if (flag(flags, 'confirm', 16) !== 'PURGE') throw new Error('--confirm must equal PURGE')
    const databaseUrl = process.env.DATABASE_URL?.trim()
    if (!databaseUrl) throw new Error('DATABASE_URL is required')
    const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: 'adms-retention' })
    try {
      output({ purgedAt: new Date().toISOString(), ...(await purgeLicensingRetention(pool)) })
    } finally {
      await pool.end()
    }
    return
  }

  const config = loadConfig()
  const pool = new Pool({ connectionString: config.databaseUrl, max: 1, application_name: 'adms-publisher-cli' })
  const repository = new PostgresLicensingRepository(pool)
  const now = new Date()
  const actorSource = process.env.USERNAME || process.env.USER || 'publisher'
  const actorPseudonym = pseudonym(config.auditHmacKey, 'publisher', actorSource)
  try {
    if (command === 'issue') {
      const tierFlag = flag(flags, 'tier')
      const tier: EntitlementTier = tierFlag === 'evaluator'
        ? 'selected_evaluator_demo'
        : tierFlag === 'pilot'
          ? 'agency_classroom_pilot'
          : (() => { throw new Error('--tier must be evaluator or pilot') })()
      const recipientRef = flag(flags, 'recipient-ref')
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const code = generateRedemptionCode()
        try {
          const record = await repository.issueCode({
            id: randomUUID(),
            digest: hmacDigest(config.codeHmacKey, 'code', code),
            tier,
            recipientRefHash: pseudonym(config.auditHmacKey, 'recipient', recipientRef),
            unusedExpiresAt: new Date(now.getTime() + UNUSED_CODE_TTL_MS),
            actorPseudonym,
            now,
          })
          output({
            code,
            codeId: record.id,
            tier,
            unusedExpiresAt: record.unusedExpiresAt.toISOString(),
            notice: 'This plaintext code is displayed once and is not stored. Transfer it securely.',
          })
          return
        } catch (error) {
          if ((error as { code?: string }).code !== '23505' || attempt === 3) throw error
        }
      }
    }

    if (command === 'status') {
      const codeValue = optionalFlag(flags, 'code', 80)
      const licenceId = optionalFlag(flags, 'license', 64)
      if (Boolean(codeValue) === Boolean(licenceId)) throw new Error('Provide exactly one of --code or --license')
      if (codeValue) {
        const code = await repository.getCodeByDigest(
          hmacDigest(config.codeHmacKey, 'code', normalizeCode(codeValue)),
        )
        output(code ? {
          codeId: code.id,
          tier: code.tier,
          status: code.status,
          entitlementId: code.entitlementId,
          unusedExpiresAt: code.unusedExpiresAt.toISOString(),
          consumedAt: code.consumedAt?.toISOString() ?? null,
        } : { status: 'not-found' })
        return
      }
      const entitlement = await repository.getEntitlement(licenceId!)
      output(entitlement ? {
        licenceId: entitlement.id,
        tier: entitlement.tier,
        status: entitlement.status,
        activatedAt: entitlement.activatedAt.toISOString(),
        expiresAt: entitlement.expiresAt.toISOString(),
        installationKeySuffix: entitlement.installationKeyThumbprint?.slice(-8) ?? null,
        replacementCount: entitlement.replacementCount,
        leaseSerial: entitlement.leaseSerial,
      } : { status: 'not-found' })
      return
    }

    if (command === 'revoke') {
      const licenceId = flag(flags, 'license', 64)
      const reason = flag(flags, 'reason', 512)
      const entitlement = await repository.revokeEntitlement(licenceId, reason, actorPseudonym, now)
      output({ licenceId: entitlement.id, status: entitlement.status, revokedAt: now.toISOString() })
      return
    }

    if (command === 'replace') {
      const licenceId = flag(flags, 'license', 64)
      const reason = flag(flags, 'reason', 512)
      const current = await repository.getEntitlement(licenceId)
      if (!current) throw new LicensingError('not-found', 'Entitlement was not found.', 404)
      const code = generateRedemptionCode()
      const unusedExpiresAt = new Date(Math.min(now.getTime() + UNUSED_CODE_TTL_MS, current.expiresAt.getTime()))
      const result = await repository.replaceEntitlement(licenceId, {
        id: randomUUID(),
        digest: hmacDigest(config.codeHmacKey, 'code', code),
        tier: current.tier,
        recipientRefHash: null,
        unusedExpiresAt,
        actorPseudonym,
        now,
      }, reason)
      output({
        code,
        codeId: result.code.id,
        licenceId,
        originalExpiresAt: result.entitlement.expiresAt.toISOString(),
        notice: 'The original installation is revoked. This replacement code is displayed once.',
      })
      return
    }

    if (command === 'promote') {
      const licenceId = flag(flags, 'license', 64)
      const tier = flag(flags, 'tier')
      const reason = flag(flags, 'reason', 512)
      if (tier !== 'pilot') throw new Error('--tier must be pilot')
      const entitlement = await repository.promoteEntitlement(
        licenceId,
        'agency_classroom_pilot',
        actorPseudonym,
        now,
        TIER_DURATION_MS.agency_classroom_pilot,
        reason,
      )
      output({
        licenceId: entitlement.id,
        tier: entitlement.tier,
        activatedAt: entitlement.activatedAt.toISOString(),
        expiresAt: entitlement.expiresAt.toISOString(),
      })
      return
    }

    throw new Error(`Unknown command: ${command}`)
  } finally {
    await pool.end()
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'Unknown publisher CLI failure'
  process.stderr.write(`Publisher command failed: ${message}\n`)
  process.exitCode = 1
})
