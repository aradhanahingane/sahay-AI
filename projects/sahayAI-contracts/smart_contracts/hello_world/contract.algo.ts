import { assert, bytes, Contract, Global, GlobalState, gtxn, Txn, uint64 } from '@algorandfoundation/algorand-typescript'

export class SahayAiLending extends Contract {
  borrower = GlobalState<string>({ key: 'borrower', initialValue: '' })
  borrowerAuth = GlobalState<bytes<32>>({ key: 'borrower_auth', initialValue: Global.zeroAddress.bytes })
  lenderAuth = GlobalState<bytes<32>>({ key: 'lender_auth', initialValue: Global.zeroAddress.bytes })
  usdcAssetId = GlobalState<uint64>({ key: 'usdc_asset_id', initialValue: 0 })
  loanAmount = GlobalState<uint64>({ key: 'loan_amount', initialValue: 0 })
  repaymentAmount = GlobalState<uint64>({ key: 'repayment_amount', initialValue: 0 })
  repaymentPercentage = GlobalState<uint64>({ key: 'repayment_percentage', initialValue: 0 })
  lockedInrPerUsdPaise = GlobalState<uint64>({ key: 'locked_inr_per_usd_paise', initialValue: 0 })
  totalUsdcOwedMicro = GlobalState<uint64>({ key: 'total_usdc_owed_micro', initialValue: 0 })
  totalUsdcRepaidMicro = GlobalState<uint64>({ key: 'total_usdc_repaid_micro', initialValue: 0 })
  loanClosed = GlobalState<uint64>({ key: 'loan_closed', initialValue: 0 })
  repaidAmount = GlobalState<uint64>({ key: 'repaid_amount', initialValue: 0 })

  set_fx_rate(lockedInrPerUsdPaise: uint64): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'only creator can set fx rate')
    assert(this.loanClosed.value === 1 || this.totalUsdcOwedMicro.value === 0, 'cannot change fx during active loan')
    assert(lockedInrPerUsdPaise > 0, 'fx rate must be greater than zero')
    this.lockedInrPerUsdPaise.value = lockedInrPerUsdPaise
  }

  private inrToMicroUsdc(amountInInr: uint64): uint64 {
    const amountInPaise: uint64 = amountInInr * 100
    const amountInMicroUsdc: uint64 = (amountInPaise * 1_000_000) / this.lockedInrPerUsdPaise.value
    return amountInMicroUsdc
  }

  create_loan(borrower: string, loanAmount: uint64, repaymentAmount: uint64, repaymentPercentage: uint64): void {
    assert(this.loanClosed.value === 1 || this.totalUsdcOwedMicro.value === 0, 'existing loan is still active')
    assert(loanAmount > 0, 'loan amount must be greater than zero')
    assert(repaymentAmount >= loanAmount, 'repayment amount must be >= loan amount')
    assert(repaymentPercentage <= 100, 'repayment percentage must be <= 100')
    assert(this.lockedInrPerUsdPaise.value > 0, 'fx rate must be set before creating loan')
    assert(Global.groupSize >= 2, 'loan creation must be grouped with a USDC transfer')
    assert(Txn.groupIndex > 0, 'loan creation app call must follow the funding transfer')

    const fundingTxn = gtxn.AssetTransferTxn(Txn.groupIndex - 1)
    assert(fundingTxn.sender.bytes === Txn.sender.bytes, 'loan funding transfer must be sent by lender caller')
    assert(fundingTxn.assetAmount > 0, 'funding transfer amount must be greater than zero')

    if (this.lenderAuth.value === Global.zeroAddress.bytes) {
      this.lenderAuth.value = Txn.sender.bytes
    } else {
      assert(Txn.sender.bytes === this.lenderAuth.value, 'only configured lender can create loans')
    }

    if (this.usdcAssetId.value === 0) {
      this.usdcAssetId.value = fundingTxn.xferAsset.id
    } else {
      assert(fundingTxn.xferAsset.id === this.usdcAssetId.value, 'funding transfer must use configured USDC asset')
    }

    this.borrower.value = borrower
    this.borrowerAuth.value = fundingTxn.assetReceiver.bytes
    this.loanAmount.value = loanAmount
    this.repaymentAmount.value = repaymentAmount
    this.repaymentPercentage.value = repaymentPercentage
    this.totalUsdcOwedMicro.value = fundingTxn.assetAmount
    this.totalUsdcRepaidMicro.value = 0
    this.loanClosed.value = 0
    this.repaidAmount.value = 0
  }

  record_repayment(amount: uint64): uint64 {
    assert(amount > 0, 'repayment amount must be greater than zero')
    assert(this.lockedInrPerUsdPaise.value > 0, 'fx rate must be set before repayment')
    assert(this.loanClosed.value === 0, 'loan is already closed')
    assert(Txn.sender.bytes === this.borrowerAuth.value, 'only borrower can record repayments')
    assert(Global.groupSize >= 2, 'repayment must be grouped with a USDC transfer')
    assert(Txn.groupIndex > 0, 'repayment app call must follow the repayment transfer')

    const microUsdcDue: uint64 = (amount * this.repaymentPercentage.value * 1_000_000) / this.lockedInrPerUsdPaise.value
    const repaymentTxn = gtxn.AssetTransferTxn(Txn.groupIndex - 1)
    assert(repaymentTxn.sender.bytes === this.borrowerAuth.value, 'repayment transfer sender must be borrower')
    assert(repaymentTxn.assetReceiver.bytes === this.lenderAuth.value, 'repayment transfer receiver must be lender')
    assert(repaymentTxn.xferAsset.id === this.usdcAssetId.value, 'repayment transfer must use configured USDC asset')
    assert(repaymentTxn.assetAmount === microUsdcDue, 'repayment transfer amount must match computed due amount')

    const nextRepaidMicro: uint64 = this.totalUsdcRepaidMicro.value + microUsdcDue
    assert(nextRepaidMicro <= this.totalUsdcOwedMicro.value, 'repayment exceeds usdc owed amount')

    this.totalUsdcRepaidMicro.value = nextRepaidMicro
    this.repaidAmount.value = this.repaidAmount.value + amount
    if (this.totalUsdcRepaidMicro.value >= this.totalUsdcOwedMicro.value) {
      this.loanClosed.value = 1
    }

    return this.totalUsdcRepaidMicro.value
  }
}
