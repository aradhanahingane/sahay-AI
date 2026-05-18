import { algo, AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { useSnackbar } from 'notistack'
import { useEffect, useMemo, useState } from 'react'
import { useWallet, Wallet, WalletId } from '@txnlab/use-wallet-react'
import { SahayAiLendingClient } from './contracts/SahayAiLending'
import { ellipseAddress } from './utils/ellipseAddress'
import { getAlgodConfigFromViteEnvironment } from './utils/network/getAlgoClientConfigs'

type Surface = 'hub' | 'merchant' | 'lender'
type MerchantStep = 'connect' | 'offer' | 'requested' | 'active-loan'

type RevenueChannel = {
  upi: boolean
  bank: boolean
  pos: boolean
}

type CashflowEntry = {
  id: string
  date: string
  channel: 'UPI' | 'BANK' | 'POS'
  amountInr: number
  ref: string
}

type CashflowSummary = {
  avgDailyRevenueInr: number
  monthlyInflowInr: number
  volatility: number
  cashflowHealth: 'Low' | 'Medium' | 'High'
  channels: Array<'UPI' | 'BANK' | 'POS'>
}

type LoanOffer = {
  id: string
  loanAmountInr: number
  repaymentAmountInr: number
  interestRateApr: number
  tenureMonths: number
  repaymentPercentage: number
  platformFeeInr: number
  score: number
  riskTier: 'A' | 'B' | 'C'
}

type CashflowPayload = {
  cashflowId: string
  offer: LoanOffer
  summary: CashflowSummary
  entries: CashflowEntry[]
}

type LoanRequest = {
  id: string
  status: 'pending' | 'approved' | 'funded'
  merchantAddress: string
  offer: LoanOffer
  summary: CashflowSummary
  createdAt: string
  lenderAddress?: string | null
  settlementGroupId?: string | null
  settlementTxIds?: string[]
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
const REPAYMENT_STEP_INR = parseBigIntWithDefault(import.meta.env.VITE_SAHAY_REPAYMENT_STEP_INR, '1000')
const LOCKED_INR_PER_USD_PAISE = parseBigIntWithDefault(import.meta.env.VITE_SAHAY_LOCKED_INR_PER_USD_PAISE, '8450')
const X402_SETTLEMENT_MICROALGO = parseBigIntWithDefault(import.meta.env.VITE_X402_SETTLEMENT_MICROALGO, '10000')
const X402_PLATFORM_FEE_MICROALGO = parseBigIntWithDefault(import.meta.env.VITE_X402_PLATFORM_FEE_MICROALGO, '20000')
const X402_PRICE_USDC = import.meta.env.VITE_X402_PRICE_USDC ?? '0.5'
const X402_TREASURY = import.meta.env.VITE_X402_TREASURY
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:4000'
const ALGORAND_MIN_ACCOUNT_BALANCE = 100000
const FALLBACK_LOAN_INR = 20000
const FALLBACK_REPAYMENT_INR = 22000

const networkExplorerBase = (network: string) => `https://lora.algokit.io/${network.toLowerCase()}`
const channelLabels: Record<keyof RevenueChannel, 'UPI' | 'BANK' | 'POS'> = { upi: 'UPI', bank: 'BANK', pos: 'POS' }

const fetchCashflowFromBackend = async (borrowerAddress: string, channels: RevenueChannel, proof?: string): Promise<CashflowPayload> => {
  const selectedChannels = Object.entries(channels)
    .filter(([, enabled]) => enabled)
    .map(([key]) => channelLabels[key as keyof RevenueChannel])
    .join(',')

  const params = new URLSearchParams({
    merchantAddress: borrowerAddress,
    channels: selectedChannels,
    count: '70',
  })

  const response = await fetch(`${API_BASE_URL}/api/cashflow?${params.toString()}`, {
    headers: proof ? { 'x402-proof': proof } : {},
  })

  if (response.status === 402) {
    const error = new Error('Payment required') as Error & { status?: number }
    error.status = 402
    throw error
  }

  if (!response.ok) {
    throw new Error('Failed to fetch cashflow data')
  }

  return response.json() as Promise<CashflowPayload>
}

const fetchLoanRequests = async (): Promise<LoanRequest[]> => {
  const response = await fetch(`${API_BASE_URL}/api/loans`)
  if (!response.ok) {
    throw new Error('Failed to load loan requests')
  }
  return response.json() as Promise<LoanRequest[]>
}

const fetchLoanRequestById = async (loanId: string): Promise<LoanRequest> => {
  const response = await fetch(`${API_BASE_URL}/api/loans/${loanId}`)
  if (!response.ok) {
    throw new Error('Failed to load loan status')
  }
  return response.json() as Promise<LoanRequest>
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
  const algorand = useMemo(() => AlgorandClient.fromConfig({ algodConfig }), [algodConfig])

  const { wallets, activeAddress, transactionSigner } = useWallet()
  const { enqueueSnackbar } = useSnackbar()

  const [surface, setSurface] = useState<Surface>('hub')
  const [merchantStep, setMerchantStep] = useState<MerchantStep>('connect')
  const [channels, setChannels] = useState<RevenueChannel>({ upi: false, bank: false, pos: false })
  const [cashflowSummary, setCashflowSummary] = useState<CashflowSummary | null>(null)
  const [cashflowEntries, setCashflowEntries] = useState<CashflowEntry[]>([])
  const [cashflowId, setCashflowId] = useState<string | null>(null)
  const [loanOffer, setLoanOffer] = useState<LoanOffer | null>(null)
  const [loanRequest, setLoanRequest] = useState<LoanRequest | null>(null)
  const [loanRequests, setLoanRequests] = useState<LoanRequest[]>([])
  const [hasPaidForCashflow, setHasPaidForCashflow] = useState(false)
  const [isPayingForCashflow, setIsPayingForCashflow] = useState(false)
  const [isSubmittingRequest, setIsSubmittingRequest] = useState(false)
  const [isFundingLoan, setIsFundingLoan] = useState(false)
  const [fundingLoanId, setFundingLoanId] = useState<string | null>(null)
  const [isLoadingLoans, setIsLoadingLoans] = useState(false)
  const [showPaywall, setShowPaywall] = useState(false)
  const [showAccessDetails, setShowAccessDetails] = useState(false)
  const [consentHash, setConsentHash] = useState<string | null>(null)
  const [consentTxId, setConsentTxId] = useState<string | null>(null)
  const [platformFeeTxId, setPlatformFeeTxId] = useState<string | null>(null)
  const [isRepaying, setIsRepaying] = useState(false)
  const [repaymentTxId, setRepaymentTxId] = useState<string | null>(null)

  const activeWallet = wallets?.find((w) => w.isActive)
  const hasSelectedChannel = channels.upi || channels.bank || channels.pos
  const loanAmountLabel = `₹${(loanOffer?.loanAmountInr ?? FALLBACK_LOAN_INR).toLocaleString('en-IN')}`
  const repaymentAmountLabel = `₹${(loanOffer?.repaymentAmountInr ?? FALLBACK_REPAYMENT_INR).toLocaleString('en-IN')}`
  const repaymentPercentageLabel = loanOffer?.repaymentPercentage ?? 10

  const connectWallet = async (wallet: Wallet) => {
    try {
      await wallet.connect()
      enqueueSnackbar(`${wallet.metadata.name} connected`, { variant: 'success' })
    } catch {
      enqueueSnackbar('Wallet connection failed', { variant: 'error' })
    }
  }

  const sendX402Payment = async (notePrefix: string, amountMicroAlgo: bigint) => {
    if (!activeAddress || !transactionSigner) {
      enqueueSnackbar('Connect wallet before payment', { variant: 'warning' })
      return null
    }

    if (APP_ID === null) {
      enqueueSnackbar('Missing or invalid VITE_SAHAY_APP_ID in frontend environment', { variant: 'error' })
      return null
    }

    const client = new SahayAiLendingClient({
      algorand,
      appId: APP_ID,
      defaultSender: activeAddress,
    })

    const payload = `${activeAddress}|${notePrefix}|${Date.now()}`
    const hash = await sha256Hex(payload)
    const receiver = X402_TREASURY || String(client.appAddress)
    if (!algosdk.isValidAddress(receiver)) {
      enqueueSnackbar('Invalid x402 treasury address configured', { variant: 'error' })
      return null
    }

    const amountMicro = Number(amountMicroAlgo)
    if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) {
      enqueueSnackbar('Invalid x402 payment amount configured', { variant: 'error' })
      return null
    }

    let receiverBalance = 0
    let receiverMinBalance = ALGORAND_MIN_ACCOUNT_BALANCE
    try {
      const receiverAccount = await algorand.client.algod.accountInformation(receiver).do()
      receiverBalance = Number(receiverAccount.amount ?? 0)
      receiverMinBalance = Number(receiverAccount.minBalance ?? ALGORAND_MIN_ACCOUNT_BALANCE)
    } catch {
      // Receiver account may not exist yet.
    }

    const receiverDeficit = Math.max(0, receiverMinBalance - receiverBalance)
    const amountToSend = Math.max(amountMicro, receiverDeficit)

    const senderAccount = await algorand.client.algod.accountInformation(activeAddress).do()
    const senderBalance = Number(senderAccount.amount ?? 0)
    const minRequired = amountToSend + 2_000
    if (senderBalance < minRequired) {
      enqueueSnackbar('Insufficient ALGO balance for consent payment + fee', { variant: 'error' })
      return null
    }

    if (amountToSend > amountMicro) {
      enqueueSnackbar('Treasury account initialized to Algorand minimum balance (0.1 ALGO)', { variant: 'info' })
    }

    const payResult = await algorand.send.payment({
      sender: activeAddress,
      signer: transactionSigner,
      receiver,
      amount: algo(amountToSend / 1_000_000),
      note: `${notePrefix}:${hash}`,
    })

    return { hash, txId: payResult.txIds[0] }
  }

  const loadCashflowData = async () => {
    if (!activeAddress) {
      enqueueSnackbar('Connect wallet first', { variant: 'warning' })
      return
    }

    try {
      const proof = hasPaidForCashflow ? consentTxId ?? consentHash ?? undefined : undefined
      const data = await fetchCashflowFromBackend(activeAddress, channels, proof)
      setCashflowSummary(data.summary)
      setCashflowEntries(data.entries)
      setLoanOffer(data.offer)
      setCashflowId(data.cashflowId)
      setMerchantStep('offer')
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
    setIsPayingForCashflow(true)
    try {
      const proof = await sendX402Payment('x402-consent', X402_SETTLEMENT_MICROALGO)
      if (!proof || !activeAddress) return

      setConsentHash(proof.hash)
      setConsentTxId(proof.txId)
      setHasPaidForCashflow(true)
      setShowPaywall(false)

      const data = await fetchCashflowFromBackend(activeAddress, channels, proof.txId)
      setCashflowSummary(data.summary)
      setCashflowEntries(data.entries)
      setLoanOffer(data.offer)
      setCashflowId(data.cashflowId)
      setMerchantStep('offer')
      enqueueSnackbar('Payment confirmed. Cashflow access granted.', { variant: 'success' })
    } catch (error) {
      enqueueSnackbar(`Payment failed: ${toErrorMessage(error)}`, { variant: 'error' })
    } finally {
      setIsPayingForCashflow(false)
    }
  }

  const submitLoanRequest = async () => {
    if (!activeAddress || !loanOffer || !cashflowId) {
      enqueueSnackbar('Unlock your cashflow to create a request', { variant: 'warning' })
      return
    }

    setIsSubmittingRequest(true)
    try {
      const proof = await sendX402Payment('x402-fee', X402_PLATFORM_FEE_MICROALGO)
      if (!proof) return

      setPlatformFeeTxId(proof.txId)

      const response = await fetch(`${API_BASE_URL}/api/loans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          merchantAddress: activeAddress,
          cashflowId,
          offerId: loanOffer.id,
          platformFeeProof: proof.txId,
        }),
      })

      if (!response.ok) {
        throw new Error('Failed to submit loan request')
      }

      const request = (await response.json()) as LoanRequest
      setLoanRequest(request)
      setMerchantStep('requested')
      enqueueSnackbar('Loan request submitted to the lending pool', { variant: 'success' })
    } catch (error) {
      enqueueSnackbar(`Request failed: ${toErrorMessage(error)}`, { variant: 'error' })
    } finally {
      setIsSubmittingRequest(false)
    }
  }

  const refreshLoanRequests = async () => {
    setIsLoadingLoans(true)
    try {
      const data = await fetchLoanRequests()
      setLoanRequests(data)
    } catch (error) {
      enqueueSnackbar(`Unable to load loan requests: ${toErrorMessage(error)}`, { variant: 'error' })
    } finally {
      setIsLoadingLoans(false)
    }
  }

  const refreshLoanRequest = async () => {
    if (!loanRequest) return
    try {
      const updated = await fetchLoanRequestById(loanRequest.id)
      setLoanRequest(updated)
      if (updated.status === 'funded') {
        setMerchantStep('active-loan')
      }
    } catch {
      // Keep status as-is.
    }
  }

  const fundLoanRequest = async (request: LoanRequest) => {
    if (APP_ID === null) {
      enqueueSnackbar('Missing or invalid VITE_SAHAY_APP_ID in frontend environment', { variant: 'error' })
      return
    }

    if (!activeAddress || !transactionSigner) {
      enqueueSnackbar('Connect a lender wallet to fund', { variant: 'warning' })
      return
    }

    setIsFundingLoan(true)
    setFundingLoanId(request.id)

    try {
      const client = new SahayAiLendingClient({
        algorand,
        appId: APP_ID,
        defaultSender: activeAddress,
      })

      const [lenderAuthState, usdcAssetIdState, lockedFxRate] = await Promise.all([
        client.state.global.lenderAuth(),
        client.state.global.usdcAssetId(),
        client.state.global.lockedInrPerUsdPaise(),
      ])

      if (!lockedFxRate || lockedFxRate === 0n) {
        enqueueSnackbar('Contract FX rate is not configured yet', { variant: 'error' })
        return
      }

      const lenderAuthBytes = lenderAuthState.asByteArray()
      if (lenderAuthBytes && lenderAuthBytes.length === 32 && !isZeroAddressBytes(lenderAuthBytes)) {
        const lenderAddress = algosdk.encodeAddress(lenderAuthBytes)
        if (lenderAddress !== activeAddress) {
          enqueueSnackbar('This app can only originate loans from the configured lender wallet', { variant: 'error' })
          return
        }
      }

      const fundingAssetId = usdcAssetIdState && usdcAssetIdState > 0n ? usdcAssetIdState : ASSET_ID
      const loanAmountInr = BigInt(Math.round(request.offer.loanAmountInr))
      const repaymentAmountInr = BigInt(Math.round(request.offer.repaymentAmountInr))
      const repaymentPercentage = BigInt(Math.round(request.offer.repaymentPercentage))
      const fundingMicroUsdc = (loanAmountInr * 100n * 1_000_000n) / lockedFxRate

      if (fundingMicroUsdc <= 0n) {
        enqueueSnackbar('Computed USDC amount is zero; verify FX rate', { variant: 'error' })
        return
      }

      const senderAccount = await algorand.client.algod.accountInformation(activeAddress).do()
      const senderAssetHolding = senderAccount.assets?.find((asset) => asset.assetId === fundingAssetId)
      if (!senderAssetHolding || Number(senderAssetHolding.amount ?? 0) < Number(fundingMicroUsdc)) {
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
          borrower: request.merchantAddress,
          loanAmount: loanAmountInr,
          repaymentAmount: repaymentAmountInr,
          repaymentPercentage,
        },
      })

      const sendResult = await algorand
        .newGroup()
        .addAssetTransfer({
          sender: activeAddress,
          signer: transactionSigner,
          assetId: fundingAssetId,
          receiver: request.merchantAddress,
          amount: fundingMicroUsdc,
        })
        .addAppCallMethodCall(appCall)
        .send({ maxRoundsToWaitForConfirmation: 4 })

      await fetch(`${API_BASE_URL}/api/loans/${request.id}/settled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lenderAddress: activeAddress,
          groupId: sendResult.groupId,
          txIds: sendResult.txIds,
        }),
      })

      enqueueSnackbar('Loan funded on-chain and recorded', { variant: 'success' })
      await refreshLoanRequests()
    } catch (error) {
      enqueueSnackbar(`Funding failed: ${toErrorMessage(error)}`, { variant: 'error' })
    } finally {
      setIsFundingLoan(false)
      setFundingLoanId(null)
    }
  }

  const resetDemo = () => {
    setMerchantStep('connect')
    setChannels({ upi: false, bank: false, pos: false })
    setCashflowSummary(null)
    setCashflowEntries([])
    setLoanOffer(null)
    setCashflowId(null)
    setLoanRequest(null)
    setHasPaidForCashflow(false)
    setShowPaywall(false)
    setShowAccessDetails(false)
    setConsentHash(null)
    setConsentTxId(null)
    setPlatformFeeTxId(null)
    setRepaymentTxId(null)
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
      const repaymentPercentage = repaymentPercentageState && repaymentPercentageState > 0n ? repaymentPercentageState : BigInt(repaymentPercentageLabel)
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
          <strong>{ellipseAddress(activeAddress, 7)}</strong>
          {activeWallet && (
            <button className="ghost" onClick={() => activeWallet.disconnect()}>
              Disconnect
            </button>
          )}
        </div>
      )}
    </div>
  )

  useEffect(() => {
    if (surface !== 'lender') return
    void refreshLoanRequests()
  }, [surface])

  useEffect(() => {
    if (!loanRequest || merchantStep !== 'requested') return
    const timer = window.setInterval(() => {
      void refreshLoanRequest()
    }, 4000)
    return () => window.clearInterval(timer)
  }, [loanRequest, merchantStep])

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
              <h2>Merchant PWA</h2>
              <p>Unlock consent-led cashflow collateral, then submit a verified loan request.</p>
              <button className="hub-cta" onClick={() => setSurface('merchant')}>
                View Mobile App
              </button>
            </article>

            <article className="hub-card">
              <div className="hub-icon">Fund</div>
              <h2>Lender Dashboard</h2>
              <p>Review AI-scored MSME requests, fund in USDC, and watch repayments settle.</p>
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
            <p className="chip">Merchant PWA</p>
            <p className="micro-copy">Loan offer: {loanAmountLabel}</p>
            <p className="micro-copy">Expected repayment: {repaymentAmountLabel}</p>
            <p className="micro-copy">Auto-repayment: {repaymentPercentageLabel}% of verified inflow</p>
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
                <h3>Verify Cashflow Collateral</h3>
                <p>Select revenue channels and unlock the cashflow feed with an x402 consent payment.</p>

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

                {cashflowSummary && (
                  <div className="cashflow-card">
                    <small>Verified Collateral Snapshot</small>
                    <p>Avg Daily Revenue: ₹{cashflowSummary.avgDailyRevenueInr.toLocaleString()}</p>
                    <p>Monthly Inflow: ₹{cashflowSummary.monthlyInflowInr.toLocaleString()}</p>
                    <p>Health: {cashflowSummary.cashflowHealth}</p>
                  </div>
                )}

                {consentHash && consentTxId && (
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

            {merchantStep === 'offer' && loanOffer && cashflowSummary && (
              <div className="phone-body success-tone">
                <div className="badge-icon success">AI</div>
                <p className="status-pill">Credit Window</p>
                <h3 className="amount">{loanAmountLabel}</h3>
                <h4>Offer Ready</h4>

                <div className="offer-card">
                  <div>
                    <span>Tenure</span>
                    <strong>{loanOffer.tenureMonths} months</strong>
                  </div>
                  <div>
                    <span>APR</span>
                    <strong>{loanOffer.interestRateApr}%</strong>
                  </div>
                  <div>
                    <span>Risk tier</span>
                    <strong>{loanOffer.riskTier}</strong>
                  </div>
                  <div>
                    <span>Platform fee</span>
                    <strong>₹{loanOffer.platformFeeInr.toLocaleString()}</strong>
                  </div>
                </div>

                <div className="cashflow-feed">
                  <div className="feed-head">
                    <span>Recent inflows</span>
                    <span>{cashflowEntries.length} entries</span>
                  </div>
                  {cashflowEntries.slice(0, 12).map((entry) => (
                    <div key={entry.id} className="cashflow-entry">
                      <div>
                        <strong>₹{entry.amountInr.toLocaleString()}</strong>
                        <span>{entry.channel}</span>
                      </div>
                      <div>
                        <span>{entry.date}</span>
                        <small>{entry.ref}</small>
                      </div>
                    </div>
                  ))}
                </div>

                <button className="phone-cta" disabled={isSubmittingRequest} onClick={submitLoanRequest}>
                  {isSubmittingRequest ? 'Submitting...' : 'Pay Platform Fee & Submit'}
                </button>
              </div>
            )}

            {merchantStep === 'requested' && (
              <div className="phone-body">
                <div className="badge-icon">Sync</div>
                <h3>Request Submitted</h3>
                <p>We are matching your request with an on-chain lender.</p>

                <div className="request-card">
                  <div>
                    <span>Status</span>
                    <strong>{loanRequest?.status ?? 'pending'}</strong>
                  </div>
                  <div>
                    <span>Request ID</span>
                    <strong>{loanRequest ? loanRequest.id.slice(0, 8) : '---'}</strong>
                  </div>
                  <div>
                    <span>Platform fee</span>
                    <strong>{platformFeeTxId ? 'Paid' : 'Pending'}</strong>
                  </div>
                </div>

                <button className="phone-cta" onClick={refreshLoanRequest}>
                  Check Funding Status
                </button>

                <button className="phone-cta muted" onClick={resetDemo}>
                  Run Demo Again
                </button>
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
                  <h3>{repaymentAmountLabel}</h3>
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

                {repaymentTxId && (
                  <div className="proof-links">
                    <small>Auto-pay and consent trail active</small>
                    <a target="_blank" rel="noreferrer" href={`${networkExplorerBase(algodConfig.network)}/transaction/${repaymentTxId}`}>
                      View latest repayment txn
                    </a>
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
              <strong>{loanRequests.filter((item) => item.status === 'funded').length}</strong>
            </article>
            <article>
              <p>Pending Requests</p>
              <strong>{loanRequests.filter((item) => item.status === 'pending').length}</strong>
            </article>
            <article>
              <p>Avg Risk Tier</p>
              <strong>{loanRequests.length ? loanRequests[0].offer.riskTier : 'B'}</strong>
            </article>
            <article>
              <p>Avg APR</p>
              <strong>
                {loanRequests.length
                  ? `${Math.round(loanRequests.reduce((sum, item) => sum + item.offer.interestRateApr, 0) / loanRequests.length)}%`
                  : '13%'}
              </strong>
            </article>
          </div>

          <div className="lender-actions">
            {renderWalletSelector()}
            <button className="hub-cta secondary" onClick={refreshLoanRequests}>
              {isLoadingLoans ? 'Refreshing...' : 'Refresh Requests'}
            </button>
          </div>

          <div className="portfolio-card">
            <h3>Loan Requests</h3>
            <p className="micro-copy">
              Each request is generated from x402-consented cashflow. Fund with USDC to settle on-chain.
            </p>
            <div className="loan-request-grid">
              {loanRequests.map((request) => (
                <div key={request.id} className="loan-request-card">
                  <div className="loan-request-head">
                    <div>
                      <strong>{ellipseAddress(request.merchantAddress, 6)}</strong>
                      <span>Cashflow health: {request.summary.cashflowHealth}</span>
                    </div>
                    <span className={`status-chip status-${request.status}`}>{request.status}</span>
                  </div>
                  <div className="loan-request-body">
                    <div>
                      <p>Loan</p>
                      <strong>₹{request.offer.loanAmountInr.toLocaleString()}</strong>
                    </div>
                    <div>
                      <p>Tenure</p>
                      <strong>{request.offer.tenureMonths} mo</strong>
                    </div>
                    <div>
                      <p>APR</p>
                      <strong>{request.offer.interestRateApr}%</strong>
                    </div>
                    <div>
                      <p>Risk</p>
                      <strong>{request.offer.riskTier}</strong>
                    </div>
                  </div>
                  <button
                    className="hub-cta"
                    disabled={isFundingLoan && fundingLoanId === request.id}
                    onClick={() => fundLoanRequest(request)}
                  >
                    {isFundingLoan && fundingLoanId === request.id ? 'Funding...' : 'Fund on Algorand'}
                  </button>
                </div>
              ))}
              {!loanRequests.length && <p className="micro-copy">No loan requests yet. Submit one from the merchant view.</p>}
            </div>
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
