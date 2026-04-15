/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENVIRONMENT: string

  readonly VITE_WALLETCONNECT_PROJECT_ID?: string

  readonly VITE_X402_PRICE_USDC?: string
  readonly VITE_X402_SETTLEMENT_MICROALGO?: string
  readonly VITE_X402_TREASURY?: string

  readonly VITE_SAHAY_APP_ID: string
  readonly VITE_SAHAY_ASSET_ID?: string
  readonly VITE_SAHAY_LOAN_AMOUNT_MICROALGO?: string
  readonly VITE_SAHAY_REPAYMENT_AMOUNT_MICROALGO?: string
  readonly VITE_SAHAY_REPAYMENT_PERCENTAGE?: string
  readonly VITE_SAHAY_LOCKED_INR_PER_USD_PAISE?: string

  readonly VITE_ALGOD_TOKEN: string
  readonly VITE_ALGOD_SERVER: string
  readonly VITE_ALGOD_PORT: string
  readonly VITE_ALGOD_NETWORK: string

  readonly VITE_INDEXER_TOKEN: string
  readonly VITE_INDEXER_SERVER: string
  readonly VITE_INDEXER_PORT: string

  readonly VITE_KMD_TOKEN: string
  readonly VITE_KMD_SERVER: string
  readonly VITE_KMD_PORT: string
  readonly VITE_KMD_PASSWORD: string
  readonly VITE_KMD_WALLET: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
