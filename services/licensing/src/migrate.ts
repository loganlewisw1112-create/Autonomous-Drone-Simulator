import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Pool } from 'pg'

export async function migrate(databaseUrl: string): Promise<number[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1, application_name: 'adms-licensing-migrate' })
  const applied: number[] = []
  try {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS licensing_schema_migrations (
         version integer PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
       )`,
    )
    const directory = resolve(import.meta.dirname, '../migrations')
    const files = (await readdir(directory)).filter((file) => /^\d+_.+\.sql$/.test(file)).sort()
    for (const file of files) {
      const version = Number(file.split('_', 1)[0])
      const existing = await pool.query('SELECT 1 FROM licensing_schema_migrations WHERE version = $1', [version])
      if (existing.rowCount) continue
      await pool.query(await readFile(resolve(directory, file), 'utf8'))
      applied.push(version)
    }
    return applied
  } finally {
    await pool.end()
  }
}
