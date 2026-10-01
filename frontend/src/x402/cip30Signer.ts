/** Build in the browser and sign with CIP-30. Only the facilitator broadcasts. */
import { Address, Assets, Client, Transaction, preprod, type UTxO } from "@evolution-sdk/evolution";
import { LOVELACE_ASSET, parseAssetUnit, type ClientCardanoSigner } from "@x402/cardano";

type Blockfrost = { baseUrl: string; projectId: string };
export interface Cip30WalletApi { getNetworkId(): Promise<number> }
const ref = (u: UTxO.UTxO) => `${Buffer.from(u.transactionId.hash).toString("hex")}#${u.index}`;
function assets(asset: string, amount: bigint) {
  if (asset === LOVELACE_ASSET) return Assets.fromLovelace(amount);
  const { policyId, assetNameHex } = parseAssetUnit(asset);
  return Assets.addByHex(Assets.fromLovelace(0n), policyId, assetNameHex, amount);
}
async function query(provider: Blockfrost, path: string) {
  return fetch(`${provider.baseUrl}${path}`, {
    headers: { project_id: provider.projectId }, signal: AbortSignal.timeout(15_000),
  });
}

/** CIP-30's testnet ID also means preview. Require live preprod inputs, at all
 * owning addresses, and exclude stale wallet inputs from fee selection too. */
export async function liveUtxos(utxos: readonly UTxO.UTxO[], provider: Blockfrost): Promise<UTxO.UTxO[]> {
  const live = new Set<string>();
  const addresses = new Set(utxos.map(u => Address.toBech32(u.address)));
  for (const address of addresses) {
    for (let page = 1; ; page++) {
      const response = await query(provider, `/addresses/${address}/utxos?count=100&page=${page}`);
      if (response.status === 404) break;
      if (!response.ok) throw new Error(`Blockfrost returned ${response.status} checking preprod inputs. Try again before signing.`);
      const rows = await response.json() as Array<{ tx_hash: string; output_index: number }>;
      for (const row of rows) live.add(`${row.tx_hash.toLowerCase()}#${row.output_index}`);
      if (rows.length < 100) break;
    }
  }
  const usable = utxos.filter(u => live.has(ref(u)));
  if (!usable.length) throw new Error("No live preprod inputs match your wallet. Select preprod, fund it, or wait for its UTxO cache to refresh after a payment.");
  return usable;
}

export async function createCip30Signer(walletApi: unknown, provider: Blockfrost): Promise<ClientCardanoSigner> {
  if (!provider.projectId?.trim()) throw new Error("Set VITE_BLOCKFROST_PROJECT_ID to a preprod project ID and restart the frontend.");
  const api = walletApi as Cip30WalletApi;
  async function checkNetwork() {
    if (await api.getNetworkId() !== 0) throw new Error("Switch your wallet to Cardano preprod before paying.");
  }
  await checkNetwork();
  const client = Client.make(preprod).withBlockfrost(provider).withCip30(walletApi as never);
  const address = Address.toBech32(await client.address());
  return {
    getAddress: () => address,
    async buildAndSignPaymentTransaction(input) {
      if (input.network !== "cardano:preprod") throw new Error("This demo supports Cardano preprod only.");
      await checkNetwork();
      const method = input.extra?.assetTransferMethod ?? "default";
      if (method !== "default") throw new Error("Unsupported payment method.");
      const utxos = await client.getWalletUtxos();
      if (!utxos.length) throw new Error("Your wallet has no inputs. Fund it from the preprod faucet.");
      const usable = await liveUtxos(utxos, provider);
      const nonceInput = usable[0];
      const output = assets(input.asset, BigInt(input.amount));
      const ttl = BigInt(Date.now() + input.maxTimeoutSeconds * 1000);
      const built = await client.newTx().collectFrom({ inputs: [nonceInput] })
        .payToAddress({ address: Address.fromBech32(input.payTo), assets: output })
        .setValidity({ to: ttl })
        .build({ changeAddress: await client.address(), availableUtxos: usable, autoMinUtxo: input.asset !== LOVELACE_ASSET });
      await checkNetwork();
      const unsigned = await built.toTransaction();
      const signed = await built.sign();
      const transaction = new Transaction.Transaction({ body: unsigned.body, witnessSet: signed.witnessSet, isValid: true, auxiliaryData: unsigned.auxiliaryData });
      return { transaction: Buffer.from(Transaction.toCBORBytes(transaction)).toString("base64"), nonce: ref(nonceInput) };
    },
  };
}
