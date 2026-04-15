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

  const lockedInrPerUsdPaise = 8450
  await appClient.send.setFxRate({
    args: {
      lockedInrPerUsdPaise,
    },
  })

  const usdcAssetId = process.env.USDC_ASSET_ID ? BigInt(process.env.USDC_ASSET_ID) : null
  const borrowerAddr = process.env.BORROWER_ADDR

  if (usdcAssetId !== null && borrowerAddr) {
    const loanFundingMicroUsdc = 500_000n
    const loanInrAmount = 20_000n

    await algorand
      .newGroup()
      .addAssetTransfer({
        sender: deployer.addr,
        receiver: borrowerAddr,
        assetId: usdcAssetId,
        amount: loanFundingMicroUsdc,
      })
      .addAppCallMethodCall(
        await appClient.params.createLoan({
          sender: deployer.addr,
          args: {
            borrower: borrowerAddr,
            loanAmount: loanInrAmount,
            repaymentAmount: 22_000,
            repaymentPercentage: 10,
          },
        }),
      )
      .send()

    consoleLogger.info(
      `Ran grouped create_loan smoke flow with USDC asset ${usdcAssetId} and borrower ${borrowerAddr}`,
    )
  } else {
    consoleLogger.info('Skipped grouped create_loan smoke flow (set USDC_ASSET_ID and BORROWER_ADDR to enable it).')
  }

  consoleLogger.info(`Locked FX rate (paise per USD): ${lockedInrPerUsdPaise}`)
  consoleLogger.info(`Use in frontend env: VITE_SAHAY_APP_ID=${appClient.appId}`)
}
