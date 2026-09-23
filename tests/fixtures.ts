import { Address, Assets, Client, Credential, preprod, Transaction, TransactionHash, UTxO } from "@evolution-sdk/evolution";
import { buildMasumiLock, decodeCardanoTransaction, parseAssetUnit, toMasumiSellerSigner, validateMasumiExtra, type CardanoUtxoSnapshot, type ClientCardanoSigner, type FacilitatorCardanoSigner } from "@x402/cardano";

// Public test phrases and fictional inputs. These tests never contact a chain.
const BUYER = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
export const seller = toMasumiSellerSigner({ mnemonic: "test test test test test test test test test test test junk", network: "cardano:preprod" });
export const protocolParameters = {
  minFeeA: 44, minFeeB: 155381, maxTxSize: 16384, maxValSize: 5000,
  keyDeposit: 2_000_000n, poolDeposit: 500_000_000n, drepDeposit: 500_000_000n,
  govActionDeposit: 100_000_000_000n, priceMem: 0.0577, priceStep: 0.0000721,
  maxTxExMem: 14_000_000n, maxTxExSteps: 10_000_000_000n, coinsPerUtxoByte: 4310n,
  collateralPercentage: 150, maxCollateralInputs: 3, minFeeRefScriptCostPerByte: 15,
  costModels: { PlutusV1: {}, PlutusV2: {}, PlutusV3: {} },
};

export async function createFixture() {
  const wallet = Client.make(preprod).withBlockfrost({ baseUrl: "http://offline.invalid" }).withSeed({ mnemonic: BUYER });
  const address = await wallet.address();
  const payer = Address.toBech32(address);
  const inputs = new Map<string, CardanoUtxoSnapshot>();
  const submitted = new Set<string>();
  let sequence = 0;
  const state = { builds: 0, broadcasts: 0, confirmations: 1, spent: false, evidenceUnavailable: false, slotOffset: 0, submissionError: false };
  const client: ClientCardanoSigner = {
    getAddress: () => payer,
    async buildAndSignPaymentTransaction(input) {
      state.builds++;
      const nonce = `${(++sequence).toString(16).padStart(64, "0")}#0`;
      const amount = BigInt(input.amount);
      const token = input.asset === "lovelace" ? null : parseAssetUnit(input.asset);
      const funding = token ? Assets.addByHex(Assets.fromLovelace(100_000_000n), token.policyId, token.assetNameHex, amount) : Assets.fromLovelace(100_000_000n);
      const utxo = new UTxO.UTxO({ transactionId: TransactionHash.fromHex(nonce.split("#")[0]), index: 0n, address, assets: funding, datumOption: undefined, scriptRef: undefined });
      inputs.set(nonce, { exists: true, address: payer, coin: funding.lovelace, assets: token ? { [input.asset]: amount } : {}, paymentKeyHash: Credential.toHex(Address.getPaymentCredential(Address.toHex(address))!) });
      let output = token ? Assets.addByHex(Assets.zero, token.policyId, token.assetNameHex, amount) : Assets.fromLovelace(amount);
      let datum;
      let ttl = BigInt(Date.now() + (input.maxTimeoutSeconds - 20) * 1000);
      if (input.extra?.assetTransferMethod === "masumi") {
        const schema = validateMasumiExtra(input.extra, input.network);
        if (!schema.ok) throw new Error(schema.detail);
        const lock = buildMasumiLock(schema.extra, payer, input.asset, amount, 4310n);
        datum = lock.datum;
        output = token ? Assets.addByHex(Assets.fromLovelace(lock.lockedLovelace), token.policyId, token.assetNameHex, amount) : Assets.fromLovelace(lock.lockedLovelace);
        ttl = BigInt(schema.extra.terms.payByTime) - 1000n;
      }
      const built = await wallet.newTx().collectFrom({ inputs: [utxo] }).payToAddress({ address: Address.fromBech32(input.payTo), assets: output, ...(datum ? { datum } : {}) }).setValidity({ to: ttl }).build({ availableUtxos: [utxo], changeAddress: address, fullProtocolParameters: protocolParameters, autoMinUtxo: Boolean(token && !datum) });
      const unsigned = await built.toTransaction();
      const signed = await built.sign();
      const tx = new Transaction.Transaction({ body: unsigned.body, witnessSet: signed.witnessSet, isValid: true, auxiliaryData: unsigned.auxiliaryData });
      return { nonce, transaction: Buffer.from(Transaction.toCBORBytes(tx)).toString("base64") };
    },
  };
  const chain: FacilitatorCardanoSigner = {
    getAddresses: () => [],
    getCurrentSlot: async () => BigInt(state.slotOffset) + preprod.slotConfig.zeroSlot + (BigInt(Date.now()) - preprod.slotConfig.zeroTime) / BigInt(preprod.slotConfig.slotLength),
    getUtxo: async ref => {
      const snapshot = inputs.get(ref);
      // Blockfrost retains a spent output's owner for verifying known payments.
      return state.spent ? { exists: false, address: snapshot?.address, paymentKeyHash: snapshot?.paymentKeyHash } : snapshot ?? { exists: false };
    },
    getProtocolParameters: async () => ({ coinsPerUtxoByte: 4310n, minFeeCoefficient: 44n, minFeeConstant: 155381n }),
    submitTransaction: async transaction => {
      state.broadcasts++;
      const { txHash } = decodeCardanoTransaction(transaction);
      if (state.submissionError) throw new Error("Fixture submission response lost");
      submitted.add(txHash);
      return { txHash, status: "mempool" };
    },
    getTransactionEvidence: async txHash => {
      if (state.evidenceUnavailable) throw new Error("Fixture provider unavailable");
      return submitted.has(txHash) && state.confirmations >= 0 ? { status: "confirmed", confirmations: state.confirmations } : { status: "unknown", confirmations: -2 };
    },
  };
  return { client, chain, state, payer };
}
