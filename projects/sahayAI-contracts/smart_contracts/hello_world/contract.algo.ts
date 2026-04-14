import { assert, Contract, GlobalState, uint64 } from '@algorandfoundation/algorand-typescript'

export class SahayAiLending extends Contract {
  borrower = GlobalState<string>({ key: 'borrower', initialValue: '' })
  loanAmount = GlobalState<uint64>({ key: 'loan_amount', initialValue: 0 })
  repaymentAmount = GlobalState<uint64>({ key: 'repayment_amount', initialValue: 0 })
  repaymentPercentage = GlobalState<uint64>({ key: 'repayment_percentage', initialValue: 0 })
  repaidAmount = GlobalState<uint64>({ key: 'repaid_amount', initialValue: 0 })

  create_loan(borrower: string, loanAmount: uint64, repaymentAmount: uint64, repaymentPercentage: uint64): void {
    assert(loanAmount > 0, 'loan amount must be greater than zero')
    assert(repaymentAmount >= loanAmount, 'repayment amount must be >= loan amount')
    assert(repaymentPercentage <= 100, 'repayment percentage must be <= 100')

    this.borrower.value = borrower
    this.loanAmount.value = loanAmount
    this.repaymentAmount.value = repaymentAmount
    this.repaymentPercentage.value = repaymentPercentage
    this.repaidAmount.value = 0
  }

  record_repayment(amount: uint64): uint64 {
    assert(amount > 0, 'repayment amount must be greater than zero')
    const nextRepaid: uint64 = this.repaidAmount.value + amount
    assert(nextRepaid <= this.repaymentAmount.value, 'repayment exceeds target amount')

    this.repaidAmount.value = nextRepaid
    return this.repaidAmount.value
  }
}
