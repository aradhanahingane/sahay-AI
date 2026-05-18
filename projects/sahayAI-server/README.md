# sahayAI-server

Node/Express backend for generating simulated MSME cashflows, producing AI-style loan offers, and tracking loan requests.

## Setup

1. Copy the environment template:
   - `copy .env.template .env`
2. Install dependencies:
   - `npm install`
3. Run the server:
   - `npm run dev`

The server starts on `http://localhost:4000` by default.

## Endpoints

- `GET /health`
- `GET /api/cashflow?merchantAddress=...&channels=upi,bank,pos&count=60`
  - Requires `x402-proof` header (any non-empty value)
  - Returns `cashflowId`, `summary`, `entries`, and `offer`
- `POST /api/loans`
  - Body: `{ merchantAddress, cashflowId, offerId, platformFeeProof }`
  - Requires `platformFeeProof` (x402-style proof)
- `GET /api/loans?status=pending|approved|funded`
- `GET /api/loans/:id`
- `POST /api/loans/:id/approve`
  - Body: `{ lenderAddress }`
- `POST /api/loans/:id/settled`
  - Body: `{ lenderAddress, groupId, txIds }`
- `GET /api/cashflow/simulator/status`
- `POST /api/cashflow/simulator/start`
  - Body (optional): `{ intervalMs, merchantWallet }`
- `POST /api/cashflow/simulator/stop`
- `GET /api/cashflow/transactions?limit=200`

## Continuous USDC Cashflow Simulator

- The server can continuously generate transaction-history style USDC entries (Algorand + PeraWallet semantics).
- Each generated transaction is persisted in SQLite table `cashflow_transactions`.
- The full transaction history is written to an Excel file (`.xlsx`) after each generated entry.
- By default, simulator auto-starts on server boot (`CASHFLOW_SIM_AUTOSTART=true`).

Key environment variables:

- `CASHFLOW_SIM_AUTOSTART`
- `CASHFLOW_SIM_INTERVAL_MS`
- `CASHFLOW_EXCEL_PATH`
- `CASHFLOW_NETWORK`
- `CASHFLOW_WALLET_PROVIDER`
- `CASHFLOW_ASSET_SYMBOL`
- `CASHFLOW_ASSET_ID`
- `CASHFLOW_MERCHANT_WALLET` (optional)

## Notes

- The x402 flow is simulated by requiring the `x402-proof` header and platform fee proof fields.
- The SQLite database is stored at `DB_PATH` (defaults to `./data/sahayai.db`).
