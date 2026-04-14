import { algo, AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { useSnackbar } from 'notistack'
import { useMemo, useState } from 'react'
import { useWallet, Wallet, WalletId } from '@txnlab/use-wallet-react'
import { SahayAiLendingClient } from './contracts/SahayAiLending'
import { getAlgodConfigFromViteEnvironment, getIndexerConfigFromViteEnvironment } from './utils/network/getAlgoClientConfigs'

type DemoStage = 'offer' | 'settling' | 'confirmed'

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

const networkExplorerBase = (network: string) => `https://lora.algokit.io/${network.toLowerCase()}`

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

  const [stage, setStage] = useState<DemoStage>('offer')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [progress, setProgress] = useState<TxProgress[]>([
    { label: 'Txn 1: Lender disbursal payment', confirmed: false },
    { label: 'Txn 2: create_loan() app call', confirmed: false },
    { label: 'Txn 3: ASA participation transaction', confirmed: false },
  ])
  const [result, setResult] = useState<SettlementResult | null>(null)

  const activeWallet = wallets?.find((w) => w.isActive)

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
          setStage('confirmed')
          enqueueSnackbar('Atomic settlement confirmed', { variant: 'success' })
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
    setStage('settling')
    setProgress([
      { label: 'Txn 1: Lender disbursal payment', confirmed: false },
      { label: 'Txn 2: create_loan() app call', confirmed: false },
      { label: 'Txn 3: ASA participation transaction', confirmed: false },
    ])

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

      enqueueSnackbar('Atomic group sent. Checking confirmations...', { variant: 'info' })
      pollForConfirmation(txIds)
    } catch {
      enqueueSnackbar('Atomic settlement failed', { variant: 'error' })
      setStage('offer')
    } finally {
      setIsSubmitting(false)
    }
  }

  const resetDemo = () => {
    setStage('offer')
    setResult(null)
    setProgress([
      { label: 'Txn 1: Lender disbursal payment', confirmed: false },
      { label: 'Txn 2: create_loan() app call', confirmed: false },
      { label: 'Txn 3: ASA participation transaction', confirmed: false },
    ])
  }

  const isKmd = (wallet: Wallet) => wallet.id === WalletId.KMD

  return (
    <main className="sahay-page">
      <section className="hero-shell">
        <p className="chip">Sahay AI • Testnet Demo</p>
        <h1>Instant Working Capital Offer</h1>
        <p className="subhead">Borrower accepts the offer, and settlement executes as one atomic group on Algorand.</p>

        {!activeAddress && (
          <div className="wallet-grid">
            {wallets?.map((wallet) => (
              <button key={wallet.id} className="wallet-btn" onClick={() => connectWallet(wallet)}>
                {!isKmd(wallet) && <img src={wallet.metadata.icon} alt={wallet.metadata.name} />}
                <span>{isKmd(wallet) ? 'LocalNet Wallet' : wallet.metadata.name}</span>
              </button>
            ))}
          </div>
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
      </section>

      {stage === 'offer' && (
        <section className="card offer-card">
          <h2>Screen 1: Offer Dashboard</h2>
          <div className="offer-grid">
            <article>
              <p>Loan Amount</p>
              <strong>{Number(LOAN_AMOUNT) / 1_000_000} ALGO</strong>
            </article>
            <article>
              <p>Repayment Amount</p>
              <strong>{Number(REPAYMENT_AMOUNT) / 1_000_000} ALGO</strong>
            </article>
            <article>
              <p>Repayment Percentage</p>
              <strong>{REPAYMENT_PERCENTAGE.toString()}%</strong>
            </article>
            <article>
              <p>App ID</p>
              <strong>{APP_ID !== null ? APP_ID.toString() : 'Missing: set VITE_SAHAY_APP_ID'}</strong>
            </article>
          </div>
          <button className="primary" disabled={!activeAddress || isSubmitting || APP_ID === null} onClick={startAtomicSettlement}>
            {isSubmitting ? 'Submitting...' : 'Accept Offer & Settle Atomically'}
          </button>
        </section>
      )}

      {stage === 'settling' && (
        <section className="card settling-card">
          <h2>Screen 2: Settlement In Progress</h2>
          <p className="subhead">Polling indexer every 500ms to track each transaction in the atomic group.</p>
          <div className="timeline">
            {progress.map((item) => (
              <div key={item.label} className={`timeline-item ${item.confirmed ? 'done' : ''}`}>
                <div className="dot" />
                <div>
                  <p>{item.label}</p>
                  <small>
                    {item.txId ? `Tx: ${item.txId}` : 'Waiting for tx id...'}
                    {item.confirmedRound ? ` • Confirmed in round ${item.confirmedRound}` : ''}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {stage === 'confirmed' && result && (
        <section className="card confirmed-card">
          <h2>Screen 3: Confirmation</h2>
          <p className="subhead">All atomic steps are confirmed and linked to one group.</p>
          <div className="result-grid">
            <p>Group ID</p>
            <strong>{result.groupId}</strong>
            <p>App</p>
            <strong>
              #{result.appId.toString()} ({result.appAddress})
            </strong>
            <p>Asset</p>
            <strong>{result.assetId.toString()}</strong>
            <p>Borrower</p>
            <strong>{result.borrower}</strong>
            <p>Confirmed Round</p>
            <strong>{result.confirmedRound}</strong>
          </div>

          <div className="links">
            {result.txIds.map((txId) => (
              <a key={txId} target="_blank" rel="noreferrer" href={`${networkExplorerBase(result.network)}/transaction/${txId}`}>
                View {txId.slice(0, 10)}... on explorer
              </a>
            ))}
          </div>

          <button className="primary" onClick={resetDemo}>
            Run Demo Again
          </button>
        </section>
      )}
    </main>
  )
}
