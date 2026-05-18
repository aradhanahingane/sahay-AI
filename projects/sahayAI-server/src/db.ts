import fs from 'node:fs'
import path from 'node:path'
import initSqlJs, { type Database, type SqlValue } from 'sql.js'

const resolveDbPath = () => {
  const configured = process.env.DB_PATH
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.join(process.cwd(), configured)
  }
  return path.join(process.cwd(), 'data', 'sahayai.db')
}

const dbPath = resolveDbPath()
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

const schema = `
  CREATE TABLE IF NOT EXISTS cashflows (
    id TEXT PRIMARY KEY,
    merchant_address TEXT NOT NULL,
    channels TEXT NOT NULL,
    consent_proof TEXT NOT NULL,
    entries_json TEXT NOT NULL,
    summary_json TEXT NOT NULL,
    offer_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS loan_requests (
    id TEXT PRIMARY KEY,
    merchant_address TEXT NOT NULL,
    cashflow_id TEXT NOT NULL,
    offer_id TEXT NOT NULL,
    status TEXT NOT NULL,
    platform_fee_proof TEXT NOT NULL,
    lender_address TEXT,
    settlement_group_id TEXT,
    settlement_tx_ids_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cashflow_transactions (
    id TEXT PRIMARY KEY,
    tx_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    network TEXT NOT NULL,
    wallet_provider TEXT NOT NULL,
    merchant_wallet TEXT NOT NULL,
    counterparty_wallet TEXT NOT NULL,
    asset_symbol TEXT NOT NULL,
    asset_id INTEGER NOT NULL,
    direction TEXT NOT NULL,
    amount_usdc REAL NOT NULL,
    amount_micro_usdc INTEGER NOT NULL,
    note TEXT,
    source TEXT NOT NULL
  );
`

let dbInstance: Database | null = null

const persistDb = (db: Database) => {
  const data = db.export()
  fs.writeFileSync(dbPath, Buffer.from(data))
}

export const getDb = async () => {
  if (dbInstance) return dbInstance
  const SQL = await initSqlJs({
    locateFile: (file: string) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
  })

  const fileExists = fs.existsSync(dbPath)
  const buffer = fileExists ? fs.readFileSync(dbPath) : undefined
  const db = new SQL.Database(buffer)
  db.exec(schema)
  persistDb(db)
  dbInstance = db
  return db
}

export const run = (db: Database, sql: string, params: SqlValue[]) => {
  const stmt = db.prepare(sql)
  stmt.run(params)
  stmt.free()
  persistDb(db)
  return db.getRowsModified()
}

export const get = (db: Database, sql: string, params: SqlValue[]) => {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const row = stmt.step() ? stmt.getAsObject() : null
  stmt.free()
  return row
}

export const all = (db: Database, sql: string, params: SqlValue[] = []) => {
  const stmt = db.prepare(sql)
  stmt.bind(params)
  const rows: Record<string, SqlValue>[] = []
  while (stmt.step()) {
    rows.push(stmt.getAsObject())
  }
  stmt.free()
  return rows
}
