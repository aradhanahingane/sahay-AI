import type { CashflowSummary } from './cashflow.js'

export type LoanOffer = {
  loanAmountInr: number
  repaymentAmountInr: number
  interestRateApr: number
  tenureMonths: number
  repaymentPercentage: number
  platformFeeInr: number
  score: number
  riskTier: 'A' | 'B' | 'C'
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

export const buildLoanOffer = (summary: CashflowSummary): LoanOffer => {
  const channelBonus = summary.channels.length >= 3 ? 8 : summary.channels.length === 2 ? 4 : 0
  const volatilityPenalty = summary.volatility * 20
  const score = clamp(Math.round(38 + summary.avgDailyRevenueInr / 190 + channelBonus - volatilityPenalty), 35, 90)

  const riskTier: LoanOffer['riskTier'] = score >= 75 ? 'A' : score >= 58 ? 'B' : 'C'
  const tenureMonths = score >= 75 ? 6 : score >= 60 ? 4 : 3
  const interestRateApr = clamp(Number((22 - score * 0.12 + summary.volatility * 4).toFixed(1)), 12, 22)
  const loanAmountInr = clamp(Math.round(summary.avgDailyRevenueInr * (tenureMonths * 2.3)), 10000, 75000)
  const repaymentAmountInr = Math.round(loanAmountInr * (1 + (interestRateApr / 100) * (tenureMonths / 12)))
  const repaymentPercentage = clamp(Math.round(8 + (70 - score) / 5), 8, 15)
  const platformFeeInr = Math.max(200, Math.round(loanAmountInr * 0.02))

  return {
    loanAmountInr,
    repaymentAmountInr,
    interestRateApr,
    tenureMonths,
    repaymentPercentage,
    platformFeeInr,
    score,
    riskTier,
  }
}
