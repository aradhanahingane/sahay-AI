import { algo, AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { useSnackbar } from 'notistack'
import { useMemo, useState } from 'react'
import { useWallet, Wallet, WalletId } from '@txnlab/use-wallet-react'
import { SahayAiLendingClient } from './contracts/SahayAiLending'
import { getAlgodConfigFromViteEnvironment, getIndexerConfigFromViteEnvironment } from './utils/network/getAlgoClientConfigs'

type Surface = 'hub' | 'merchant' | 'lender'
type MerchantStep = 'connect' | 'approved' | 'settling' | 'active-loan'

type TxProgress = {
  label: string
  txId?: string
  confirmedRound?: number
  confirmed: boolean
}

type SettlementResult = {
  groupId: string
  appId: bigint
  appAddress: string
  assetId: bigint
  network: string
  borrower: string
  loanAmount: bigint
  repaymentAmount: bigint
  repaymentPercentage: bigint
  txIds: string[]
  confirmedRound: number
}

type RevenueChannel = {
  upi: boolean
  bank: boolean
  pos: boolean
}

type CashflowData = {
  avgDailyRevenueInr: number
  monthlyInflowInr: number
  cashflowHealth: 'Low' | 'Medium' | 'High'
}

const parseRequiredBigInt = (value: string | undefined) => {
  if (!value) return null
  try {
    const parsed = BigInt(value)
    return parsed > 0n ? parsed : null
  } catch {
    return null
  }
}

const parseBigIntWithDefault = (value: string | undefined, fallback: string) => {
  if (!value) return BigInt(fallback)
  try {
    return BigInt(value)
  } catch {
    return BigInt(fallback)
  }
}

const APP_ID = parseRequiredBigInt(import.meta.env.VITE_SAHAY_APP_ID)
const ASSET_ID = parseBigIntWithDefault(import.meta.env.VITE_SAHAY_ASSET_ID, '10458941')
const LOAN_AMOUNT = parseBigIntWithDefault(import.meta.env.VITE_SAHAY_LOAN_AMOUNT_MICROALGO, '500000')
const REPAYMENT_AMOUNT = parseBigIntWithDefault(import.meta.env.VITE_SAHAY_REPAYMENT_AMOUNT_MICROALGO, '550000')
const REPAYMENT_PERCENTAGE = parseBigIntWithDefault(import.meta.env.VITE_SAHAY_REPAYMENT_PERCENTAGE, '10')
const X402_SETTLEMENT_MICROALGO = parseBigIntWithDefault(import.meta.env.VITE_X402_SETTLEMENT_MICROALGO, '10000')
const X402_PRICE_USDC = import.meta.env.VITE_X402_PRICE_USDC ?? '0.5'
const X402_TREASURY = import.meta.env.VITE_X402_TREASURY

const networkExplorerBase = (network: string) => `https://lora.algokit.io/${network.toLowerCase()}`
const initialProgress = (): TxProgress[] => [
  { label: 'Payment initiated', confirmed: false },
  { label: 'Loan record updated', confirmed: false },
  { label: 'Consent link finalized', confirmed: false },
]

const fetchCashflowFromBackend = async (borrowerAddress: string, paid: boolean): Promise<CashflowData> => {
  if (!paid) {
    const error = new Error('Payment required') as Error & { status?: number }
    error.status = 402
    throw error
  }

  const tail = Number.parseInt(borrowerAddress.slice(-2), 16)
  const avgDailyRevenueInr = 3200 + (tail % 7) * 370
  const monthlyInflowInr = avgDailyRevenueInr * 30
  const cashflowHealth: CashflowData['cashflowHealth'] = avgDailyRevenueInr > 4300 ? 'High' : avgDailyRevenueInr > 3600 ? 'Medium' : 'Low'
  return { avgDailyRevenueInr, monthlyInflowInr, cashflowHealth }
}

const sha256Hex = async (value: string) => {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export default function Home() {
  const algodConfig = getAlgodConfigFromViteEnvironment()
  const indexerConfig = getIndexerConfigFromViteEnvironment()
  const algorand = useMemo(() => AlgorandClient.fromConfig({ algodConfig }), [algodConfig])
  const indexer = useMemo(
    () => new algosdk.Indexer(String(indexerConfig.token), indexerConfig.server, indexerConfig.port),
    [indexerConfig],
  )

  const { wallets, activeAddress, transactionSigner } = useWallet()
  const { enqueueSnackbar } = useSnackbar()

  const [surface, setSurface] = useState<Surface>('hub')
  const [merchantStep, setMerchantStep] = useState<MerchantStep>('connect')
  const [channels, setChannels] = useState<RevenueChannel>({ upi: false, bank: false, pos: false })
  const [cashflowData, setCashflowData] = useState<CashflowData | null>(null)
  const [hasPaidForCashflow, setHasPaidForCashflow] = useState(false)
  const [isPayingForCashflow, setIsPayingForCashflow] = useState(false)
  const [showPaywall, setShowPaywall] = useState(false)
  const [showAccessDetails, setShowAccessDetails] = useState(false)
  const [consentHash, setConsentHash] = useState<string | null>(null)
  const [consentTxId, setConsentTxId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [progress, setProgress] = useState<TxProgress[]>(initialProgress)
  const [result, setResult] = useState<SettlementResult | null>(null)

  const activeWallet = wallets?.find((w) => w.isActive)
  const canAnalyze = (channels.upi || channels.bank || channels.pos) && cashflowData !== null
  const loanAmountAlgo = (Number(LOAN_AMOUNT) / 1_000_000).toFixed(2)
  const repaymentAmountAlgo = (Number(REPAYMENT_AMOUNT) / 1_000_000).toFixed(2)

  const connectWallet = async (wallet: Wallet) => {
    try {
      await wallet.connect()
      enqueueSnackbar(`${wallet.metadata.name} connected`, { variant: 'success' })
    } catch {
      enqueueSnackbar('Wallet connection failed', { variant: 'error' })
    }
  }

  const getAssetHolding = async (address: string, assetId: bigint) => {
    const account = await algorand.client.algod.accountInformation(address).do()
    const holdings = account.assets ?? []
    return holdings.find((item) => BigInt(item.assetId) === assetId)
  }

  const pollForConfirmation = (txIds: string[]) => {
    const timer = window.setInterval(async () => {
      try {
        const checks = await Promise.all(
          txIds.map(async (txId) => {
            const tx = await indexer.lookupTransactionByID(txId).do()
            const round = Number(tx.transaction.confirmedRound ?? 0)
            return { txId, confirmedRound: round, confirmed: round > 0 }
          }),
        )

        setProgress((current) =>
          current.map((item, i) => ({
            ...item,
            txId: checks[i]?.txId,
            confirmedRound: checks[i]?.confirmedRound,
            confirmed: checks[i]?.confirmed ?? false,
          })),
        )

        const allConfirmed = checks.every((tx) => tx.confirmed)
        if (allConfirmed) {
          window.clearInterval(timer)
          setResult((current) =>
            current
              ? {
                  ...current,
                  confirmedRound: Math.max(...checks.map((c) => c.confirmedRound)),
                }
              : current,
          )
          setMerchantStep('active-loan')
          enqueueSnackbar('Transfer completed', { variant: 'success' })
        }
      } catch {
        // Keep polling; indexer propagation can lag temporarily.
      }
    }, 500)
  }

  const startAtomicSettlement = async () => {
    if (APP_ID === null) {
      enqueueSnackbar('Missing or invalid VITE_SAHAY_APP_ID in frontend environment', { variant: 'error' })
      return
    }

    if (!activeAddress || !transactionSigner) {
      enqueueSnackbar('Connect wallet before accepting the offer', { variant: 'warning' })
      return
    }

    setIsSubmitting(true)
    setMerchantStep('settling')
    setProgress(initialProgress())

    try {
      const client = new SahayAiLendingClient({
        algorand,
        appId: APP_ID,
        defaultSender: activeAddress,
      })

      const appCall = await client.params.createLoan({
        sender: activeAddress,
        signer: transactionSigner,
        args: {
          borrower: activeAddress,
          loanAmount: LOAN_AMOUNT,
          repaymentAmount: REPAYMENT_AMOUNT,
          repaymentPercentage: REPAYMENT_PERCENTAGE,
        },
      })

      const assetHolding = await getAssetHolding(activeAddress, ASSET_ID)
      const composer = algorand
        .newGroup()
        .addPayment({
          sender: activeAddress,
          signer: transactionSigner,
          receiver: client.appAddress,
          amount: algo(Number(LOAN_AMOUNT) / 1_000_000),
        })
        .addAppCallMethodCall(appCall)

      if (assetHolding) {
        composer.addAssetTransfer({
          sender: activeAddress,
          signer: transactionSigner,
          assetId: ASSET_ID,
          receiver: activeAddress,
          amount: 0n,
        })
      } else {
        composer.addAssetOptIn({
          sender: activeAddress,
          signer: transactionSigner,
          assetId: ASSET_ID,
        })
      }

      const sendResult = await composer.send({ maxRoundsToWaitForConfirmation: 4 })
      const txIds = sendResult.txIds
      setProgress((current) =>
        current.map((item, i) => ({
          ...item,
          txId: txIds[i],
        })),
      )

      setResult({
        groupId: sendResult.groupId,
        appId: APP_ID,
        appAddress: String(client.appAddress),
        assetId: ASSET_ID,
        network: algodConfig.network,
        borrower: activeAddress,
        loanAmount: LOAN_AMOUNT,
        repaymentAmount: REPAYMENT_AMOUNT,
        repaymentPercentage: REPAYMENT_PERCENTAGE,
        txIds,
        confirmedRound: 0,
      })

      enqueueSnackbar('Transfer submitted. Finalizing...', { variant: 'info' })
      pollForConfirmation(txIds)
    } catch {
      enqueueSnackbar('Transfer failed. Please try again.', { variant: 'error' })
      setMerchantStep('approved')
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetDemo = () => {
    setMerchantStep('connect')
    setChannels({ upi: false, bank: false, pos: false })
    setCashflowData(null)
    setHasPaidForCashflow(false)
    setShowPaywall(false)
    setShowAccessDetails(false)
    setConsentHash(null)
    setConsentTxId(null)
    setResult(null)
    setProgress(initialProgress())
  }

  const isKmd = (wallet: Wallet) => wallet.id === WalletId.KMD

  const toggleChannel = (channel: keyof RevenueChannel) => {
    setChannels((current) => ({ ...current, [channel]: !current[channel] }))
  }

  const loadCashflowData = async () => {
    if (!activeAddress) {
      enqueueSnackbar('Connect wallet first', { variant: 'warning' })
      return
    }

    try {
      const data = await fetchCashflowFromBackend(activeAddress, hasPaidForCashflow)
      setCashflowData(data)
      enqueueSnackbar('Cashflow data unlocked', { variant: 'success' })
    } catch (error) {
      const status = (error as { status?: number })?.status
      if (status === 402) {
        setShowPaywall(true)
        enqueueSnackbar('Access requires micro-payment', { variant: 'info' })
      } else {
        enqueueSnackbar('Failed to fetch cashflow data', { variant: 'error' })
      }
    }
  }

  const payAndContinueForCashflow = async () => {
    if (!activeAddress || !transactionSigner) {
      enqueueSnackbar('Connect wallet before payment', { variant: 'warning' })
      return
    }

    if (APP_ID === null) {
      enqueueSnackbar('Missing or invalid VITE_SAHAY_APP_ID in frontend environment', { variant: 'error' })
      return
    }

    setIsPayingForCashflow(true)
    try {
      const client = new SahayAiLendingClient({
        algorand,
        appId: APP_ID,
        defaultSender: activeAddress,
      })

      const consentPayload = `${activeAddress}|cashflow-read|${Date.now()}`
      const hash = await sha256Hex(consentPayload)
      const receiver = X402_TREASURY || String(client.appAddress)
      const payResult = await algorand.send.payment({
        sender: activeAddress,
        signer: transactionSigner,
        receiver,
        amount: algo(Number(X402_SETTLEMENT_MICROALGO) / 1_000_000),
        note: `x402-consent:${hash}`,
      })

      setConsentHash(hash)
      setConsentTxId(payResult.txIds[0])
      setHasPaidForCashflow(true)
      setShowPaywall(false)

      const data = await fetchCashflowFromBackend(activeAddress, true)
      setCashflowData(data)
      enqueueSnackbar('Payment confirmed. Cashflow access granted.', { variant: 'success' })
    } catch {
      enqueueSnackbar('Payment failed. Access still locked.', { variant: 'error' })
    } finally {
      setIsPayingForCashflow(false)
    }
  }

  const renderWalletSelector = () => (
    <div className="wallet-area">
      {!activeAddress && (
        <>
          <p className="micro-copy">Secure sign-in required to continue</p>
          <div className="wallet-grid">
            {wallets?.map((wallet) => (
              <button key={wallet.id} className="wallet-btn" onClick={() => connectWallet(wallet)}>
                {!isKmd(wallet) && <img src={wallet.metadata.icon} alt={wallet.metadata.name} />}
                <span>{isKmd(wallet) ? 'LocalNet Wallet' : wallet.metadata.name}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {activeAddress && (
        <div className="active-wallet">
          <span className="label">Connected wallet</span>
          <strong>{activeAddress}</strong>
          {activeWallet && (
            <button className="ghost" onClick={() => activeWallet.disconnect()}>
              Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  )

  return (
    <main className="hub-root">
      {surface !== 'hub' && (
        <button className="back-btn" onClick={() => setSurface('hub')}>
          Back to Hub
        </button>
      )}

      {surface === 'hub' && (
        <section className="hub-wrap">
          <div className="logo-pill">S</div>
          <h1 className="hub-title">Sahay Hub</h1>
          <p className="hub-subtitle">Choose how you want to explore the Sahay micro-lending experience.</p>

          <div className="hub-grid">
            <article className="hub-card">
              <div className="hub-icon">Store</div>
              <h2>Merchant App</h2>
              <p>See how a small business unlocks fast working-capital credit with consent-led data access.</p>
              <button className="hub-cta" onClick={() => setSurface('merchant')}>
                View Mobile App
              </button>
            </article>

            <article className="hub-card">
              <div className="hub-icon">Fund</div>
              <h2>Lender Dashboard</h2>
              <p>Monitor pool health, anonymized borrower performance, and repayment behavior.</p>
              <button className="hub-cta secondary" onClick={() => setSurface('lender')}>
                View Dashboard
              </button>
            </article>
          </div>
        </section>
      )}

      {surface === 'merchant' && (
        <section className="merchant-wrap">
          <aside className="merchant-side">
            <p className="chip">Merchant App</p>
            <p className="micro-copy">Loan offer: Rs20,000</p>
            <p className="micro-copy">Auto-repayment: {REPAYMENT_PERCENTAGE.toString()}% of verified inflow</p>
            {renderWalletSelector()}
          </aside>

          <div className="phone-shell">
            <div className="phone-notch" />
            <div className="phone-head">
              <span>9:41</span>
              <span>● ● ●</span>
            </div>

            {merchantStep === 'connect' && (
              <div className="phone-body">
                <div className="badge-icon">Shield</div>
                <h3>Calculate Your Loan Limit</h3>
                <p>Select your primary sales channels to verify daily cashflow.</p>

                <div className="x402-banner">
                  <p>Collateral data access</p>
                  <button className="x402-btn" onClick={loadCashflowData}>
                    Fetch Cashflow Data
                  </button>
                  <button className="x402-link" onClick={() => setShowAccessDetails((v) => !v)}>
                    {showAccessDetails ? 'Hide access details' : 'View access details'}
                  </button>
                </div>

                {showAccessDetails && (
                  <div className="x402-details">
                    <small>x402-inspired access rule</small>
                    <p>Data is shared only after a micro-payment consent event.</p>
                    <p>Collateral sources: UPI settlement flow, bank inflow trends, POS receipts.</p>
                    <p>Each data release writes a consent hash to create an audit trail.</p>
                  </div>
                )}

                <button className={`channel ${channels.upi ? 'selected' : ''}`} onClick={() => toggleChannel('upi')}>
                  <span>Connect UPI</span>
                  <span className="radio">{channels.upi ? 'ON' : ''}</span>
                </button>
                <button className={`channel ${channels.bank ? 'selected' : ''}`} onClick={() => toggleChannel('bank')}>
                  <span>Connect Bank Account</span>
                  <span className="radio">{channels.bank ? 'ON' : ''}</span>
                </button>
                <button className={`channel ${channels.pos ? 'selected' : ''}`} onClick={() => toggleChannel('pos')}>
                  <span>Connect POS System</span>
                  <span className="radio">{channels.pos ? 'ON' : ''}</span>
                </button>

                <button className="phone-cta muted" disabled={!canAnalyze} onClick={() => setMerchantStep('approved')}>
                  Analyze Cash Flow
                </button>

                {cashflowData && (
                  <div className="cashflow-card">
                    <small>Verified Collateral Snapshot</small>
                    <p>Avg Daily Revenue: Rs{cashflowData.avgDailyRevenueInr.toLocaleString()}</p>
                    <p>Monthly Inflow: Rs{cashflowData.monthlyInflowInr.toLocaleString()}</p>
                    <p>Health: {cashflowData.cashflowHealth}</p>
                  </div>
                )}

                {showAccessDetails && consentHash && consentTxId && (
                  <div className="consent-proof">
                    <small>Technical consent receipt</small>
                    <p>{consentHash.slice(0, 22)}...</p>
                    <a target="_blank" rel="noreferrer" href={`${networkExplorerBase(algodConfig.network)}/transaction/${consentTxId}`}>
                      View consent txn
                    </a>
                  </div>
                )}
              </div>
            )}

            {merchantStep === 'approved' && (
              <div className="phone-body success-tone">
                <div className="badge-icon success">OK</div>
                <p className="status-pill">Credit Generated</p>
                <h3 className="amount">Rs20,000</h3>
                <h4>Approved</h4>

                <div className="info-card">
                  <p>Repayment auto-set to {REPAYMENT_PERCENTAGE.toString()}% of linked flow.</p>
                </div>

                <button className="phone-cta" disabled={!activeAddress || APP_ID === null || isSubmitting} onClick={startAtomicSettlement}>
                  {isSubmitting ? 'Submitting...' : 'Accept & Transfer to Bank'}
                </button>
              </div>
            )}

            {merchantStep === 'settling' && (
              <div className="phone-body">
                <div className="badge-icon">Sync</div>
                <h3>Processing Transfer</h3>
                <p>Please wait while we securely complete your transfer.</p>
                <div className="timeline compact">
                  {progress.map((item) => (
                    <div key={item.label} className={`timeline-item ${item.confirmed ? 'done' : ''}`}>
                      <div className="dot" />
                      <div>
                        <p>{item.label}</p>
                        <small>{item.confirmedRound ? `Round ${item.confirmedRound}` : item.txId ? item.txId.slice(0, 14) : 'Pending...'}</small>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {merchantStep === 'active-loan' && (
              <div className="phone-body">
                <div className="loan-head">
                  <strong>Kiran Traders</strong>
                  <span>ACTIVE LOAN</span>
                </div>

                <div className="loan-card">
                  <p>Remaining Balance</p>
                  <h3>Rs19,480</h3>
                  <div className="progress-bar">
                    <div className="progress-fill" />
                  </div>
                </div>

                <div className="tx-list">
                  <div>
                    <span>Deduction</span>
                    <strong>-Rs20 live</strong>
                  </div>
                  <div>
                    <span>Deduction</span>
                    <strong>-Rs45 today</strong>
                  </div>
                  <div>
                    <span>Deduction</span>
                    <strong>-Rs120 yesterday</strong>
                  </div>
                </div>

                {result && (
                  <div className="proof-links">
                    <small>Auto-pay and consent trail active</small>
                    {showAccessDetails && (
                      <>
                        <small>Ref: {result.groupId.slice(0, 18)}...</small>
                        {result.txIds.map((txId) => (
                          <a key={txId} target="_blank" rel="noreferrer" href={`${networkExplorerBase(result.network)}/transaction/${txId}`}>
                            View {txId.slice(0, 8)}...
                          </a>
                        ))}
                      </>
                    )}
                  </div>
                )}

                <button className="phone-cta muted" onClick={resetDemo}>
                  Run Demo Again
                </button>
              </div>
            )}
          </div>
        </section>
      )}

      {surface === 'lender' && (
        <section className="lender-wrap">
          <header>
            <p className="chip">Funding Dashboard</p>
            <h2>Pool Health and MSME Exposure</h2>
          </header>

          <div className="lender-grid">
            <article>
              <p>Active MSME Loans</p>
              <strong>184</strong>
            </article>
            <article>
              <p>Liquidity Deployed</p>
              <strong>Rs52.4L</strong>
            </article>
            <article>
              <p>Repayment Efficiency</p>
              <strong>96.2%</strong>
            </article>
            <article>
              <p>Avg Yield (APR)</p>
              <strong>13.8%</strong>
            </article>
          </div>

          <div className="portfolio-card">
            <h3>Recent Settlement Groups</h3>
            <p className="micro-copy">
              x402-inspired model: collateral data is released after micro-payment consent, with auditable consent hashes.
            </p>
            <ul>
              <li>
                <span>MSME-A17</span>
                <span>Disbursal completed</span>
              </li>
              <li>
                <span>MSME-D03</span>
                <span>Repayment auto-deducting</span>
              </li>
              <li>
                <span>MSME-B24</span>
                <span>Yield stream healthy</span>
              </li>
            </ul>
          </div>
        </section>
      )}

      {showPaywall && (
        <div className="paywall-backdrop" onClick={() => setShowPaywall(false)}>
          <div className="paywall-modal" onClick={(e) => e.stopPropagation()}>
            <p className="chip">Payment Required</p>
            <h3>Access requires {X402_PRICE_USDC} USDC</h3>
            <p>
              To unlock collateral cashflow data, complete a micro-payment consent step. We then release the data and log
              an auditable consent hash.
            </p>
            <div className="paywall-actions">
              <button className="hub-cta secondary" onClick={() => setShowPaywall(false)}>
                Cancel
              </button>
              <button className="hub-cta" disabled={isPayingForCashflow} onClick={payAndContinueForCashflow}>
                {isPayingForCashflow ? 'Paying...' : 'Pay & Continue'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
