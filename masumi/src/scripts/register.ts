/** Mints this agent's Masumi registry NFT (V2) to the selling wallet. */
import { blockfrost, listing, sellerWallet } from "../config.js";
import { createChain } from "../chain.js";
import { registryMetadata } from "../masumi.js";

const seller = sellerWallet();
const agent = listing();
console.log(`Registering "${agent.name}" at ${agent.apiBaseUrl}\nseller ${seller.address}`);
const chain = createChain({ blockfrost, mnemonic: seller.mnemonic, sellerAddress: seller.address });
const { txHash, agentIdentifier } = await chain.register(registryMetadata(agent));
console.log(`\nSubmitted ${txHash}\nhttps://preprod.cardanoscan.io/transaction/${txHash}\n`);
console.log(`Add this line to masumi/.env:\nMASUMI_AGENT_IDENTIFIER=${agentIdentifier}`);
