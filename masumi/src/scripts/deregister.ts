/** Burns the registry NFT named by MASUMI_AGENT_IDENTIFIER. The registry then marks the agent deregistered. */
import { agentIdentifier, blockfrost, sellerWallet } from "../config.js";
import { createChain } from "../chain.js";

const seller = sellerWallet();
const chain = createChain({ blockfrost, mnemonic: seller.mnemonic, sellerAddress: seller.address });
const txHash = await chain.deregister(agentIdentifier());
console.log(`Burned ${agentIdentifier()}\nhttps://preprod.cardanoscan.io/transaction/${txHash}`);
