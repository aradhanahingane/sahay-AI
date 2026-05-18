import { createHash } from 'node:crypto'

export type RevenueChannel = 'UPI' | 'BANK' | 'POS'

export type CashflowEntry = {
  id: string
  date: string
  channel: RevenueChannel
  amountInr: number
  ref: string
}

export type CashflowSummary = {
  avgDailyRevenueInr: number
  monthlyInflowInr: number
  volatility: number
  cashflowHealth: 'Low' | 'Medium' | 'High'
  channels: RevenueChannel[]
}

const mulberry32 = (seed: number) => {
  let t = seed
  return () => {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), t | 1)
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

const seedFromString = (value: string) => {
  const hash = createHash('sha256').update(value).digest()
  return hash.readUInt32LE(0)
}

const pickWeighted = (rng: () => number, channels: RevenueChannel[]) => {
  const weights = channels.map((channel) => (channel === 'UPI' ? 0.52 : channel === 'BANK' ? 0.28 : 0.2))
  const total = weights.reduce((sum, w) => sum + w, 0)
  const draw = rng() * total
  let cursor = 0
  for (let i = 0; i < channels.length; i += 1) {
    cursor += weights[i]
    if (draw <= cursor) return channels[i]
  }
  return channels[0]
}

export const generateCashflow = (seed: string, channels: RevenueChannel[], count: number) => {
  const normalizedChannels: RevenueChannel[] = channels.length ? channels : ['UPI', 'BANK', 'POS']
  const rng = mulberry32(seedFromString(seed))
  const entries: CashflowEntry[] = []

  const base = 1800 + Math.floor(rng() * 1400)
  for (let i = 0; i < count; i += 1) {
    const channel = pickWeighted(rng, normalizedChannels)
    const variance = 0.65 + rng() * 1.15
    const amountInr = Math.round(base * variance + rng() * 320)
    const daysAgo = Math.floor(rng() * 30)
    const date = new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10)
    const ref = `${channel}-${Math.floor(1000 + rng() * 9000)}`

    entries.push({
      id: `${seed.slice(0, 6)}-${i}-${daysAgo}`,
      date,
      channel,
      amountInr,
      ref,
    })
  }

  entries.sort((a, b) => (a.date < b.date ? 1 : -1))

  const total = entries.reduce((sum, entry) => sum + entry.amountInr, 0)
  const avgDailyRevenueInr = Math.round(total / 30)
  const mean = total / Math.max(entries.length, 1)
  const variance = entries.reduce((sum, entry) => sum + Math.pow(entry.amountInr - mean, 2), 0) / Math.max(entries.length, 1)
  const volatility = Math.min(1, Math.sqrt(variance) / Math.max(mean, 1))

  const cashflowHealth = avgDailyRevenueInr >= 4500 ? 'High' : avgDailyRevenueInr >= 3200 ? 'Medium' : 'Low'

  const summary: CashflowSummary = {
    avgDailyRevenueInr,
    monthlyInflowInr: total,
    volatility: Number(volatility.toFixed(2)),
    cashflowHealth,
    channels: normalizedChannels,
  }

  return { entries, summary }
}
