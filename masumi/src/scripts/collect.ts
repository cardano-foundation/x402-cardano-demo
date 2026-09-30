/**
 * Withdraws every escrow payment whose result was submitted and whose unlock
 * time has passed. Stop the agent first so both do not spend the same inputs.
 */
import { blockfrost, sellerWallet } from "../config.js";
import { createChain } from "../chain.js";

const seller = sellerWallet();
const chain = createChain({ blockfrost, mnemonic: seller.mnemonic, sellerAddress: seller.address });
const results = await chain.collectAll();
if (!results.length) console.log("Nothing to collect yet: no ResultSubmitted escrow of this seller is past its unlock time.");
for (const r of results) {
  console.log("txHash" in r
    ? `Collected ${r.ref}: https://preprod.cardanoscan.io/transaction/${r.txHash}`
    : `Could not collect ${r.ref}: ${r.error}`);
}
