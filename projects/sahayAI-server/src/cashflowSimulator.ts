import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import type { Database } from 'sql.js'
import { all, run } from './db.js'

type Direction = 'credit' | 'debit'

type SimulatorOptions = {
  db: Database
  excelPath: string
  defaultIntervalMs: number
  network: string
  walletProvider: string
  assetSymbol: string
  assetId: number
  merchantWallet: string
}

type StartOverrides = {
  intervalMs?: number
  merchantWallet?: string
}

type CashflowTransaction = {
  id: string
  txId: string
  timestamp: string
  network: string
  walletProvider: string
  merchantWallet: string
  counterpartyWallet: string
  assetSymbol: string
  assetId: number
  direction: Direction
  amountUsdc: number
  amountMicroUsdc: number
  note: string
  source: 'simulator'
}

const randomAlgorandAddress = () => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let result = ''
  for (let i = 0; i < 58; i += 1) {
    result += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return result
}

export class CashflowSimulator {
  private readonly db: Database
  private readonly excelPath: string
  private readonly defaultIntervalMs: number
  private readonly network: string
  private readonly walletProvider: string
  private readonly assetSymbol: string
  private readonly assetId: number
  private merchantWallet: string
  private intervalMs: number
  private timer: NodeJS.Timeout | null = null
  private lastWrittenAt: string | null = null
  private isWriting = false

  constructor(options: SimulatorOptions) {
    this.db = options.db
    this.excelPath = options.excelPath
    this.defaultIntervalMs = options.defaultIntervalMs
    this.intervalMs = options.defaultIntervalMs
    this.network = options.network
    this.walletProvider = options.walletProvider
    this.assetSymbol = options.assetSymbol
    this.assetId = options.assetId
    this.merchantWallet = options.merchantWallet

    fs.mkdirSync(path.dirname(this.excelPath), { recursive: true })
  }

  getStatus() {
    return {
      running: this.timer !== null,
      intervalMs: this.intervalMs,
      excelPath: this.excelPath,
      merchantWallet: this.merchantWallet,
      lastWrittenAt: this.lastWrittenAt,
    }
  }

  start(overrides?: StartOverrides) {
    if (this.timer) {
      return this.getStatus()
    }

    this.intervalMs = overrides?.intervalMs && overrides.intervalMs > 250 ? overrides.intervalMs : this.defaultIntervalMs
    this.merchantWallet = overrides?.merchantWallet?.trim() || this.merchantWallet

    const runTick = async () => {
      if (this.isWriting) return
      this.isWriting = true
      try {
        const entry = this.buildEntry()
        this.insertEntry(entry)
        await this.writeExcelFile()
      } finally {
        this.isWriting = false
      }
    }

    void runTick()
    this.timer = setInterval(() => {
      void runTick()
    }, this.intervalMs)

    return this.getStatus()
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    return this.getStatus()
  }

  listTransactions(limit: number) {
    const normalizedLimit = Math.max(1, Math.min(limit, 1000))
    const rows = all(
      this.db,
      `SELECT * FROM cashflow_transactions ORDER BY timestamp DESC LIMIT ?`,
      [normalizedLimit]
    )

    return rows.map((row) => ({
      id: String(row.id),
      txId: String(row.tx_id),
      timestamp: String(row.timestamp),
      network: String(row.network),
      walletProvider: String(row.wallet_provider),
      merchantWallet: String(row.merchant_wallet),
      counterpartyWallet: String(row.counterparty_wallet),
      assetSymbol: String(row.asset_symbol),
      assetId: Number(row.asset_id),
      direction: String(row.direction),
      amountUsdc: Number(row.amount_usdc),
      amountMicroUsdc: Number(row.amount_micro_usdc),
      note: String(row.note ?? ''),
      source: String(row.source),
    }))
  }

  private buildEntry(): CashflowTransaction {
    const direction: Direction = Math.random() > 0.42 ? 'credit' : 'debit'
    const amountUsdc = Number((1 + Math.random() * 220).toFixed(2))
    const amountMicroUsdc = Math.round(amountUsdc * 1_000_000)
    const timestamp = new Date().toISOString()
    const txId = randomUUID().replaceAll('-', '').toUpperCase().slice(0, 52)

    return {
      id: randomUUID(),
      txId,
      timestamp,
      network: this.network,
      walletProvider: this.walletProvider,
      merchantWallet: this.merchantWallet,
      counterpartyWallet: randomAlgorandAddress(),
      assetSymbol: this.assetSymbol,
      assetId: this.assetId,
      direction,
      amountUsdc,
      amountMicroUsdc,
      note: direction === 'credit' ? 'USDC customer payment received via PeraWallet' : 'USDC supplier payout initiated via PeraWallet',
      source: 'simulator',
    }
  }

  private insertEntry(entry: CashflowTransaction) {
    run(
      this.db,
      `INSERT INTO cashflow_transactions (
         id, tx_id, timestamp, network, wallet_provider, merchant_wallet, counterparty_wallet,
         asset_symbol, asset_id, direction, amount_usdc, amount_micro_usdc, note, source
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.id,
        entry.txId,
        entry.timestamp,
        entry.network,
        entry.walletProvider,
        entry.merchantWallet,
        entry.counterpartyWallet,
        entry.assetSymbol,
        entry.assetId,
        entry.direction,
        entry.amountUsdc,
        entry.amountMicroUsdc,
        entry.note,
        entry.source,
      ]
    )
  }

  private async writeExcelFile() {
    const rows = all(
      this.db,
      `SELECT
         tx_id as txId,
         timestamp,
         network,
         wallet_provider as walletProvider,
         merchant_wallet as merchantWallet,
         counterparty_wallet as counterpartyWallet,
         asset_symbol as assetSymbol,
         asset_id as assetId,
         direction,
         amount_usdc as amountUsdc,
         amount_micro_usdc as amountMicroUsdc,
         note,
         source
       FROM cashflow_transactions
       ORDER BY timestamp DESC`
    )

    const worksheet = XLSX.utils.json_to_sheet(rows)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'USDC_Cashflow')
    XLSX.writeFile(workbook, this.excelPath)
    this.lastWrittenAt = new Date().toISOString()
  }
}

export const buildSimulator = (db: Database) => {
  const excelPath = process.env.CASHFLOW_EXCEL_PATH
    ? path.isAbsolute(process.env.CASHFLOW_EXCEL_PATH)
      ? process.env.CASHFLOW_EXCEL_PATH
      : path.join(process.cwd(), process.env.CASHFLOW_EXCEL_PATH)
    : path.join(process.cwd(), 'data', 'algorand_usdc_cashflow.xlsx')

  const defaultIntervalMs = Number(process.env.CASHFLOW_SIM_INTERVAL_MS ?? 5000)
  const safeIntervalMs = Number.isFinite(defaultIntervalMs) ? Math.max(500, defaultIntervalMs) : 5000

  return new CashflowSimulator({
    db,
    excelPath,
    defaultIntervalMs: safeIntervalMs,
    network: process.env.CASHFLOW_NETWORK ?? 'algorand-testnet',
    walletProvider: process.env.CASHFLOW_WALLET_PROVIDER ?? 'PeraWallet',
    assetSymbol: process.env.CASHFLOW_ASSET_SYMBOL ?? 'USDC',
    assetId: Number(process.env.CASHFLOW_ASSET_ID ?? 10458941),
    merchantWallet: process.env.CASHFLOW_MERCHANT_WALLET ?? randomAlgorandAddress(),
  })
}
