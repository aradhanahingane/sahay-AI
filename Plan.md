Node Server : Generates dummy data for simulating cashflow. These cashflows will be given to an AI which will decide amount of loan, interest rate and tenure of loan.

Web app for lenders will feature an option to view latest loan requirements and option to approve/fund any loan requests. The loans will be given in USDC.

PWA for loan takers. PWA will provide cashflow in form small number of entries (50-100) for which our platform pays using x402. 
PWA charges a platform fees from loan takers, also recieved through x402.

We're using x402 and USDC here for payments. Everything stored on Algorand blockchain and a backend database (SQLite or MongoDB). Changes in backend DB takes place only after write() func executes on Algo.

Payment from platform to lender is automated based on the loan structure i.e. Tenure, 2% fees and amount of loan. Payment towards platform through PWA is also automated from loan taker's USDC account i.e. Perawallet.



