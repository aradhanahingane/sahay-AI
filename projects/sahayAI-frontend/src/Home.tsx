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
const REPAYMENT_STEP_INR = parseBigIntWithDefault(import.meta.env.VITE_SAHAY_REPAYMENT_STEP_INR, '1000')
const LOCKED_INR_PER_USD_PAISE = parseBigIntWithDefault(import.meta.env.VITE_SAHAY_LOCKED_INR_PER_USD_PAISE, '8450')
const X402_SETTLEMENT_MICROALGO = parseBigIntWithDefault(import.meta.env.VITE_X402_SETTLEMENT_MICROALGO, '10000')
const X402_PRICE_USDC = import.meta.env.VITE_X402_PRICE_USDC ?? '0.5'
const X402_TREASURY = import.meta.env.VITE_X402_TREASURY
const ALGORAND_MIN_ACCOUNT_BALANCE = 100000
const LOAN_AMOUNT_INR = 20000
const REPAYMENT_AMOUNT_INR = 22000

const networkExplorerBase = (network: string) => `https://lora.algokit.io/${network.toLowerCase()}`
const initialProgress = (): TxProgress[] => [
  { label: 'USDC funding sent', confirmed: false },
  { label: 'Loan record updated', confirmed: false },
  { label: 'Group finalized', confirmed: false },
]

const fetchCashflowFromBackend = async (borrowerAddress: string, paid: boolean): Promise<CashflowData> => {
  if (!paid) {
    const error = new Error('Payment required') as Error & { status?: number }
    error.status = 402
    throw error
  }

  const addressScore = Array.from(borrowerAddress).reduce((total, character) => total + character.charCodeAt(0), 0)
  const avgDailyRevenueInr = 3200 + (addressScore % 7) * 370
  const monthlyInflowInr = avgDailyRevenueInr * 30
  const cashflowHealth: CashflowData['cashflowHealth'] = avgDailyRevenueInr > 4300 ? 'High' : avgDailyRevenueInr > 3600 ? 'Medium' : 'Low'
  return { avgDailyRevenueInr, monthlyInflowInr, cashflowHealth }
}

const sha256Hex = async (value: string) => {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const isZeroAddressBytes = (value: Uint8Array) => value.every((b) => b === 0)
const toErrorMessage = (error: unknown) => {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  return 'Unknown error'
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
  const [isRepaying, setIsRepaying] = useState(false)
  const [repaymentTxId, setRepaymentTxId] = useState<string | null>(null)

  const activeWallet = wallets?.find((w) => w.isActive)
  const hasSelectedChannel = channels.upi || channels.bank || channels.pos
  const canAnalyze = hasSelectedChannel && cashflowData !== null
  const loanAmountLabel = `₹${LOAN_AMOUNT_INR.toLocaleString('en-IN')}`
  const repaymentAmountLabel = `₹${REPAYMENT_AMOUNT_INR.toLocaleString('en-IN')}`

  const connectWallet = async (wallet: Wallet) => {
    try {
      await wallet.connect()
      enqueueSnackbar(`${wallet.metadata.name} connected`, { variant: 'success' })
    } catch {
      enqueueSnackbar('Wallet connection failed', { variant: 'error' })
    }
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

      const [lenderAuthState, usdcAssetIdState] = await Promise.all([
        client.state.global.lenderAuth(),
        client.state.global.usdcAssetId(),
      ])
      const lenderAuthBytes = lenderAuthState.asByteArray()
      if (lenderAuthBytes && lenderAuthBytes.length === 32 && !isZeroAddressBytes(lenderAuthBytes)) {
        const lenderAddress = algosdk.encodeAddress(lenderAuthBytes)
        if (lenderAddress !== activeAddress) {
          enqueueSnackbar('This app can only originate loans from the configured lender wallet', { variant: 'error' })
          return
        }
      }
      const fundingAssetId = usdcAssetIdState && usdcAssetIdState > 0n ? usdcAssetIdState : ASSET_ID

      const lockedFxRate = await client.state.global.lockedInrPerUsdPaise()
      if (!lockedFxRate || lockedFxRate === 0n) {
        if (LOCKED_INR_PER_USD_PAISE <= 0n) {
          enqueueSnackbar('Missing VITE_SAHAY_LOCKED_INR_PER_USD_PAISE value', { variant: 'error' })
          return
        }

        await client.send.setFxRate({
          sender: activeAddress,
          signer: transactionSigner,
          args: {
            lockedInrPerUsdPaise: LOCKED_INR_PER_USD_PAISE,
          },
        })
        enqueueSnackbar(`Initialized contract FX rate to ${LOCKED_INR_PER_USD_PAISE.toString()} paise per USD`, {
          variant: 'info',
        })
      }

      const [borrowerAuthState, totalUsdcOwedMicroState, totalUsdcRepaidMicroState, loanClosedState] = await Promise.all([
        client.state.global.borrowerAuth(),
        client.state.global.totalUsdcOwedMicro(),
        client.state.global.totalUsdcRepaidMicro(),
        client.state.global.loanClosed(),
      ])
      const activeLoanOpen = (loanClosedState ?? 0n) === 0n && (totalUsdcOwedMicroState ?? 0n) > (totalUsdcRepaidMicroState ?? 0n)
      if (activeLoanOpen) {
        const borrowerBytes = borrowerAuthState.asByteArray()
        const borrowerAddress = borrowerBytes && borrowerBytes.length === 32 && !isZeroAddressBytes(borrowerBytes)
          ? algosdk.encodeAddress(borrowerBytes)
          : null
        if (!borrowerAddress || borrowerAddress === activeAddress) {
          setMerchantStep('active-loan')
          enqueueSnackbar('An active loan already exists. Open the live loan view instead of creating a new one.', {
            variant: 'info',
          })
          return
        }
        enqueueSnackbar('This app already has an active loan on-chain', { variant: 'error' })
        return
      }

      const senderAccount = await algorand.client.algod.accountInformation(activeAddress).do()
      const senderAssetHolding = senderAccount.assets?.find((asset) => asset.assetId === fundingAssetId)
      if (!senderAssetHolding || Number(senderAssetHolding.amount ?? 0) < Number(LOAN_AMOUNT)) {
        enqueueSnackbar(
          `Connected wallet does not hold enough of asset ${fundingAssetId.toString()} to fund the loan`,
          { variant: 'error' },
        )
        return
      }

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

      const composer = algorand
        .newGroup()
        .addAssetTransfer({
          sender: activeAddress,
          signer: transactionSigner,
          assetId: fundingAssetId,
          receiver: activeAddress,
          amount: LOAN_AMOUNT,
        })
        .addAppCallMethodCall(appCall)

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
        assetId: fundingAssetId,
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
    } catch (error) {
      enqueueSnackbar(`Transfer failed: ${toErrorMessage(error)}`, { variant: 'error' })
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
    setRepaymentTxId(null)
    setResult(null)
    setProgress(initialProgress())
  }

  const submitRepayment = async () => {
    if (APP_ID === null) {
      enqueueSnackbar('Missing or invalid VITE_SAHAY_APP_ID in frontend environment', { variant: 'error' })
      return
    }

    if (!activeAddress || !transactionSigner) {
      enqueueSnackbar('Connect wallet before repayment', { variant: 'warning' })
      return
    }

    setIsRepaying(true)
    try {
      const client = new SahayAiLendingClient({
        algorand,
        appId: APP_ID,
        defaultSender: activeAddress,
      })

      const [lockedFxRate, lenderAuthState, borrowerAuthState, usdcAssetIdState, loanClosedState, totalUsdcOwedMicroState, totalUsdcRepaidMicroState, repaymentPercentageState] = await Promise.all([
        client.state.global.lockedInrPerUsdPaise(),
        client.state.global.lenderAuth(),
        client.state.global.borrowerAuth(),
        client.state.global.usdcAssetId(),
        client.state.global.loanClosed(),
        client.state.global.totalUsdcOwedMicro(),
        client.state.global.totalUsdcRepaidMicro(),
        client.state.global.repaymentPercentage(),
      ])

      if (!lockedFxRate || lockedFxRate === 0n) {
        enqueueSnackbar('Contract FX rate is not configured yet', { variant: 'error' })
        return
      }
      if (loanClosedState === 1n) {
        enqueueSnackbar('Loan is already closed', { variant: 'info' })
        return
      }

      const lenderBytes = lenderAuthState.asByteArray()
      if (!lenderBytes || lenderBytes.length !== 32 || isZeroAddressBytes(lenderBytes)) {
        enqueueSnackbar('Lender account not set on contract', { variant: 'error' })
        return
      }
      const lenderAddress = algosdk.encodeAddress(lenderBytes)

      const borrowerBytes = borrowerAuthState.asByteArray()
      if (!borrowerBytes || borrowerBytes.length !== 32 || isZeroAddressBytes(borrowerBytes)) {
        enqueueSnackbar('Borrower account not set on contract', { variant: 'error' })
        return
      }
      const borrowerAddress = algosdk.encodeAddress(borrowerBytes)
      if (borrowerAddress !== activeAddress) {
        enqueueSnackbar('Connect the borrower wallet to record repayments', { variant: 'error' })
        return
      }

      const repaymentAssetId = usdcAssetIdState && usdcAssetIdState > 0n ? usdcAssetIdState : ASSET_ID
      const repaymentPercentage = repaymentPercentageState && repaymentPercentageState > 0n ? repaymentPercentageState : REPAYMENT_PERCENTAGE
      const remainingOwedMicroUsdc = (totalUsdcOwedMicroState ?? 0n) > (totalUsdcRepaidMicroState ?? 0n)
        ? (totalUsdcOwedMicroState ?? 0n) - (totalUsdcRepaidMicroState ?? 0n)
        : 0n
      const maxSafeRepaymentInr = remainingOwedMicroUsdc > 0n && repaymentPercentage > 0n
        ? (remainingOwedMicroUsdc * lockedFxRate) / (repaymentPercentage * 1_000_000n)
        : 0n
      const repaymentStepInr = REPAYMENT_STEP_INR <= maxSafeRepaymentInr ? REPAYMENT_STEP_INR : maxSafeRepaymentInr
      if (repaymentStepInr <= 0n) {
        enqueueSnackbar('No remaining repayment capacity is available for this loan', { variant: 'error' })
        return
      }
      if (repaymentStepInr !== REPAYMENT_STEP_INR) {
        enqueueSnackbar(
          `Repayment step adjusted to ₹${repaymentStepInr.toString()} to fit the remaining on-chain balance`,
          { variant: 'info' },
        )
      }

      const repaymentMicroUsdc = (repaymentStepInr * repaymentPercentage * 1_000_000n) / lockedFxRate
      if (repaymentMicroUsdc <= 0n) {
        enqueueSnackbar('Repayment amount resolves to zero; adjust settings', { variant: 'error' })
        return
      }

      const appCall = await client.params.recordRepayment({
        sender: activeAddress,
        signer: transactionSigner,
        args: {
          amount: repaymentStepInr,
        },
      })

      const sendResult = await algorand
        .newGroup()
        .addAssetTransfer({
          sender: activeAddress,
          signer: transactionSigner,
          assetId: repaymentAssetId,
          receiver: lenderAddress,
          amount: repaymentMicroUsdc,
        })
        .addAppCallMethodCall(appCall)
        .send({ maxRoundsToWaitForConfirmation: 4 })

      setRepaymentTxId(sendResult.txIds[0] ?? null)
      enqueueSnackbar('Repayment submitted and recorded on-chain', { variant: 'success' })
    } catch (error) {
      enqueueSnackbar(`Repayment failed: ${toErrorMessage(error)}`, { variant: 'error' })
    } finally {
      setIsRepaying(false)
    }
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
      if (!algosdk.isValidAddress(receiver)) {
        enqueueSnackbar('Invalid x402 treasury address configured', { variant: 'error' })
        return
      }

      const amountMicroAlgo = Number(X402_SETTLEMENT_MICROALGO)
      if (!Number.isSafeInteger(amountMicroAlgo) || amountMicroAlgo <= 0) {
        enqueueSnackbar('Invalid VITE_X402_SETTLEMENT_MICROALGO value', { variant: 'error' })
        return
      }

      let receiverBalance = 0
      let receiverMinBalance = ALGORAND_MIN_ACCOUNT_BALANCE
      try {
        const receiverAccount = await algorand.client.algod.accountInformation(receiver).do()
        receiverBalance = Number(receiverAccount.amount ?? 0)
        receiverMinBalance = Number(receiverAccount.minBalance ?? ALGORAND_MIN_ACCOUNT_BALANCE)
      } catch {
        // If account doesn't exist yet, funding at least min balance is required to create it.
      }

      const receiverDeficit = Math.max(0, receiverMinBalance - receiverBalance)
      const amountToSend = Math.max(amountMicroAlgo, receiverDeficit)

      const senderAccount = await algorand.client.algod.accountInformation(activeAddress).do()
      const senderBalance = Number(senderAccount.amount ?? 0)
      const minRequired = amountToSend + 2_000
      if (senderBalance < minRequired) {
        enqueueSnackbar('Insufficient ALGO balance for consent payment + fee', { variant: 'error' })
        return
      }

      if (amountToSend > amountMicroAlgo) {
        enqueueSnackbar('Treasury account is being initialized to Algorand minimum balance (0.1 ALGO)', { variant: 'info' })
      }

      const payResult = await algorand.send.payment({
        sender: activeAddress,
        signer: transactionSigner,
        receiver,
        amount: algo(amountToSend / 1_000_000),
        note: `x402-consent:${hash}`,
      })

      setConsentHash(hash)
      setConsentTxId(payResult.txIds[0])
      setHasPaidForCashflow(true)
      setShowPaywall(false)

      const data = await fetchCashflowFromBackend(activeAddress, true)
      setCashflowData(data)
      enqueueSnackbar('Payment confirmed. Cashflow access granted.', { variant: 'success' })
    } catch (error) {
      enqueueSnackbar(`Payment failed: ${toErrorMessage(error)}`, { variant: 'error' })
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
            <p className="micro-copy">Loan offer: {loanAmountLabel}</p>
            <p className="micro-copy">Expected repayment: {repaymentAmountLabel}</p>
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

                <button
                  className={`phone-cta ${hasSelectedChannel ? 'analysis-ready' : 'muted'}`}
                  disabled={!canAnalyze}
                  onClick={() => setMerchantStep('approved')}
                >
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
                <h3 className="amount">₹20,000</h3>
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
                  <h3>₹19,480</h3>
                  <div className="progress-bar">
                    <div className="progress-fill" />
                  </div>
                </div>

                <div className="tx-list">
                  <div>
                    <span>Deduction</span>
                    <strong>-₹20 live</strong>
                  </div>
                  <div>
                    <span>Deduction</span>
                    <strong>-₹45 today</strong>
                  </div>
                  <div>
                    <span>Deduction</span>
                    <strong>-₹120 yesterday</strong>
                  </div>
                </div>

                <button className="phone-cta" disabled={isRepaying || !activeAddress || APP_ID === null} onClick={submitRepayment}>
                  {isRepaying ? 'Processing Repayment...' : `Run Repayment Step (₹${REPAYMENT_STEP_INR.toString()})`}
                </button>

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
                    {repaymentTxId && (
                      <a target="_blank" rel="noreferrer" href={`${networkExplorerBase(algodConfig.network)}/transaction/${repaymentTxId}`}>
                        View latest repayment txn
                      </a>
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
              <strong>₹52.4L</strong>
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
