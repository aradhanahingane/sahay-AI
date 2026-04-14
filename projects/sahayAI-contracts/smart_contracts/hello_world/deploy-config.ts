import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import { SahayAiLendingFactory } from '../artifacts/hello_world/SahayAiLendingClient'
import { consoleLogger } from '@algorandfoundation/algokit-utils/types/logging'

// Below is a showcase of various deployment options you can use in TypeScript Client
export async function deploy() {
  consoleLogger.info('=== Deploying SahayAiLending ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = await algorand.account.fromEnvironment('DEPLOYER')

  const factory = algorand.client.getTypedAppFactory(SahayAiLendingFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient, result } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })

  consoleLogger.info(`Deployment operation: ${result.operationPerformed}`)
  consoleLogger.info(`APP_ID=${appClient.appId}`)
  consoleLogger.info(`APP_ADDRESS=${appClient.appAddress}`)

  // If app was just created fund the app account
  if (['create', 'replace'].includes(result.operationPerformed)) {
    await algorand.send.payment({
      amount: (1).algo(),
      sender: deployer.addr,
      receiver: appClient.appAddress,
    })
  }

  const method = 'create_loan'
  await appClient.send.createLoan({
    args: {
      borrower: String(deployer.addr),
      loanAmount: 20000,
      repaymentAmount: 22000,
      repaymentPercentage: 10,
    },
  })

  const response = await appClient.send.recordRepayment({
    args: { amount: 1000 },
  })

  consoleLogger.info(
    `Called ${method} and record_repayment on ${appClient.appClient.appName} (${appClient.appClient.appId}); repaid total: ${response.return}`,
  )
  consoleLogger.info(`Use in frontend env: VITE_SAHAY_APP_ID=${appClient.appId}`)
}
