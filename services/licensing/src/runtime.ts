import { Pool } from 'pg'
import { loadConfig } from './config.js'
import { PostgresLicensingRepository } from './repository.js'
import { LicensingService } from './service.js'

let service: LicensingService | undefined
let pool: Pool | undefined

export function getLicensingService(): LicensingService {
  if (service) return service
  const config = loadConfig()
  pool = new Pool({
    connectionString: config.databaseUrl,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 5_000,
    application_name: 'adms-licensing',
  })
  service = new LicensingService({
    config,
    repository: new PostgresLicensingRepository(pool),
  })
  return service
}

export async function closeRuntimeForTest(): Promise<void> {
  await pool?.end()
  pool = undefined
  service = undefined
}
