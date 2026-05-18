import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import type { Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildLoanOffer } from './ai.js'
import { buildSimulator } from './cashflowSimulator.js'
import { generateCashflow, type RevenueChannel } from './cashflow.js'
import { all, get, getDb, run } from './db.js'

dotenv.config()

const app = express()
const db = await getDb()
const port = Number(process.env.PORT ?? 4000)
const corsOrigin = process.env.CORS_ORIGIN ?? '*'
const x402Price = process.env.X402_PRICE_USDC ?? '0.5'
const simulator = buildSimulator(db)

app.use(cors({ origin: corsOrigin }))
app.use(express.json({ limit: '1mb' }))

const parseChannels = (raw: string | undefined): RevenueChannel[] => {
  if (!raw) return []
  return raw
    .split(',')
    .map((value) => value.trim().toUpperCase())
    .filter((value): value is RevenueChannel => value === 'UPI' || value === 'BANK' || value === 'POS')
}

const mapLoanRow = (row: any) => ({
  id: row.id,
  status: row.status,
  merchantAddress: row.merchant_address,
  offer: JSON.parse(row.offer_json),
  summary: JSON.parse(row.summary_json),
  createdAt: row.created_at,
  lenderAddress: row.lender_address ?? null,
  settlementGroupId: row.settlement_group_id ?? null,
  settlementTxIds: row.settlement_tx_ids_json ? JSON.parse(row.settlement_tx_ids_json) : [],
})

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

app.get('/api/cashflow/simulator/status', (_req, res) => {
  res.json(simulator.getStatus())
})

app.post('/api/cashflow/simulator/start', (req, res) => {
  const bodySchema = z.object({
    intervalMs: z.number().int().min(250).optional(),
    merchantWallet: z.string().min(16).optional(),
  })
  const parsed = bodySchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid start request body' })
    return
  }

  const status = simulator.start(parsed.data)
  res.json({ message: 'Cashflow simulator started', ...status })
})

app.post('/api/cashflow/simulator/stop', (_req, res) => {
  const status = simulator.stop()
  res.json({ message: 'Cashflow simulator stopped', ...status })
})

app.get('/api/cashflow/transactions', (req, res) => {
  const limitQuery = typeof req.query.limit === 'string' ? Number(req.query.limit) : 200
  const transactions = simulator.listTransactions(Number.isFinite(limitQuery) ? limitQuery : 200)
  res.json({
    count: transactions.length,
    transactions,
    simulator: simulator.getStatus(),
  })
})

app.get('/api/cashflow', (req, res) => {
  const proof = req.header('x402-proof')
  if (!proof) {
    res.status(402).json({ error: 'Payment required', priceUsdc: x402Price })
    return
  }

  const querySchema = z.object({
    merchantAddress: z.string().min(10),
    channels: z.string().optional(),
    count: z.string().optional(),
  })
  const parsed = querySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid query parameters' })
    return
  }

  const count = parsed.data.count ? Number(parsed.data.count) : 70
  const normalizedCount = Number.isFinite(count) ? Math.min(Math.max(count, 50), 100) : 70
  const channels = parseChannels(parsed.data.channels)
  const { entries, summary } = generateCashflow(parsed.data.merchantAddress, channels, normalizedCount)
  const offer = buildLoanOffer(summary)
  const offerId = randomUUID()
  const cashflowId = randomUUID()
  const createdAt = new Date().toISOString()

  run(
    db,
    `INSERT INTO cashflows (id, merchant_address, channels, consent_proof, entries_json, summary_json, offer_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ,
    [
      cashflowId,
      parsed.data.merchantAddress,
      channels.join(','),
      proof,
      JSON.stringify(entries),
      JSON.stringify(summary),
      JSON.stringify({ ...offer, id: offerId }),
      createdAt,
    ]
  )

  res.json({
    cashflowId,
    offer: { ...offer, id: offerId },
    summary,
    entries,
  })
})

app.post('/api/loans', (req, res) => {
  const bodySchema = z.object({
    merchantAddress: z.string().min(10),
    cashflowId: z.string().min(8),
    offerId: z.string().min(8),
    platformFeeProof: z.string().min(6),
  })
  const parsed = bodySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body' })
    return
  }

  const cashflowRow = get(db, 'SELECT offer_json, summary_json FROM cashflows WHERE id = ?', [parsed.data.cashflowId]) as
    | { offer_json: string; summary_json: string }
    | null
  if (!cashflowRow) {
    res.status(404).json({ error: 'Cashflow not found' })
    return
  }

  const id = randomUUID()
  const now = new Date().toISOString()

  run(
    db,
    `INSERT INTO loan_requests (id, merchant_address, cashflow_id, offer_id, status, platform_fee_proof, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ,
    [
      id,
      parsed.data.merchantAddress,
      parsed.data.cashflowId,
      parsed.data.offerId,
      'pending',
      parsed.data.platformFeeProof,
      now,
      now,
    ]
  )

  res.status(201).json({
    id,
    status: 'pending',
    merchantAddress: parsed.data.merchantAddress,
    offer: JSON.parse(cashflowRow.offer_json),
    summary: JSON.parse(cashflowRow.summary_json),
    createdAt: now,
  })
})

app.get('/api/loans', (req, res) => {
  const status = typeof req.query.status === 'string' ? req.query.status : undefined
  const rows = status
    ? all(
        db,
        `SELECT lr.*, cf.offer_json, cf.summary_json
         FROM loan_requests lr
         JOIN cashflows cf ON cf.id = lr.cashflow_id
         WHERE lr.status = ?
         ORDER BY lr.created_at DESC`,
        [status]
      )
    : all(
        db,
        `SELECT lr.*, cf.offer_json, cf.summary_json
         FROM loan_requests lr
         JOIN cashflows cf ON cf.id = lr.cashflow_id
         ORDER BY lr.created_at DESC`
      )

  res.json(rows.map(mapLoanRow))
})

app.get('/api/loans/:id', (req, res) => {
  const row = get(
    db,
    `SELECT lr.*, cf.offer_json, cf.summary_json
     FROM loan_requests lr
     JOIN cashflows cf ON cf.id = lr.cashflow_id
     WHERE lr.id = ?`,
    [req.params.id]
  )
  if (!row) {
    res.status(404).json({ error: 'Loan request not found' })
    return
  }

  res.json(mapLoanRow(row))
})

app.post('/api/loans/:id/approve', (req, res) => {
  const bodySchema = z.object({
    lenderAddress: z.string().min(10),
  })
  const parsed = bodySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body' })
    return
  }

  const updatedAt = new Date().toISOString()
  const changes = run(
    db,
    `UPDATE loan_requests
     SET status = 'approved', lender_address = ?, updated_at = ?
     WHERE id = ?`,
    [parsed.data.lenderAddress, updatedAt, req.params.id]
  )
  if (changes === 0) {
    res.status(404).json({ error: 'Loan request not found' })
    return
  }

  res.json({ status: 'approved', updatedAt })
})

app.post('/api/loans/:id/settled', (req, res) => {
  const bodySchema = z.object({
    lenderAddress: z.string().min(10),
    groupId: z.string().min(6),
    txIds: z.array(z.string().min(6)).min(1),
  })
  const parsed = bodySchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid request body' })
    return
  }

  const updatedAt = new Date().toISOString()
  const changes = run(
    db,
    `UPDATE loan_requests
     SET status = 'funded', lender_address = ?, settlement_group_id = ?, settlement_tx_ids_json = ?, updated_at = ?
     WHERE id = ?`,
    [parsed.data.lenderAddress, parsed.data.groupId, JSON.stringify(parsed.data.txIds), updatedAt, req.params.id]
  )
  if (changes === 0) {
    res.status(404).json({ error: 'Loan request not found' })
    return
  }

  res.json({ status: 'funded', updatedAt })
})

const autostartEnabled = (process.env.CASHFLOW_SIM_AUTOSTART ?? 'true').toLowerCase() === 'true'
const maxPortRetries = 10

const startServer = (requestedPort: number, attempt = 0): void => {
  const candidatePort = requestedPort + attempt
  const server: Server = app.listen(candidatePort)

  server.once('listening', () => {
    process.env.PORT = String(candidatePort)
    console.log(`sahayAI server running on http://localhost:${candidatePort}`)
    if (autostartEnabled) {
      const status = simulator.start()
      console.log(
        `cashflow simulator started: every ${status.intervalMs}ms writing to ${status.excelPath}`,
      )
    }
  })

  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && attempt < maxPortRetries) {
      console.warn(
        `Port ${candidatePort} is already in use. Retrying with port ${candidatePort + 1}...`,
      )
      startServer(requestedPort, attempt + 1)
      return
    }

    throw error
  })
}

startServer(port)
