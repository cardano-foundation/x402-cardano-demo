/**
 * An `@x402/cardano` client signer over a CIP-30 wallet, for Masumi escrow
 * offers only. The wallet signs; the agent's facilitator broadcasts.
 */
import { Address, Assets, Client, Transaction, preprod, type UTxO } from "@evolution-sdk/evolution";
import { buildMasumiLock, LOVELACE_ASSET, parseAssetUnit, parseMasumiLockDatum, validateMasumiExtra, verifyMasumiAuthorization, type CardanoExtraMasumi, type ClientCardanoSigner } from "@x402/cardano";
import { formatTusdm, NETWORK, TUSDM_POLICY_ID } from "../constants.js";
import { makeRegistryValidator, type Blockfrost } from "../registry.js";
import type { SignerContext } from "./x402Flow.js";

interface Cip30Api { getNetworkId(): Promise<number> }
const ada = (lovelace: bigint) => `${(Number(lovelace) / 1e6).toFixed(2)} tADA`;
const ref = (u: UTxO.UTxO) => `${Buffer.from(u.transactionId.hash).toString("hex")}#${u.index}`;

/**
 * @param context - What the buyer asked for (the job body the seller's quote
 *   must commit to, and the protected resource from the 402; the x402 client
 *   does not pass the resource to signers) plus callbacks that report the
 *   verification and the built lock to the UI.
 */
export async function createCip30Signer(walletApi: unknown, blockfrost: Blockfrost, context: SignerContext): Promise<ClientCardanoSigner> {
  const api = walletApi as Cip30Api;
  if (await api.getNetworkId() !== 0) throw new Error("Switch your wallet to Cardano preprod.");
  const client = Client.make(preprod).withBlockfrost(blockfrost).withCip30(walletApi as never);
  const address = Address.toBech32(await client.address());
  const registryValidator = makeRegistryValidator(blockfrost);
  return {
    getAddress: () => address,
    // Called by ExactCardanoScheme with the offer the x402 client selected.
    // Order: (a) validate and verify the seller's terms, (b) check it is our
    // job, (c) build the lock output, (d) sign it. Nothing is broadcast here.
    async buildAndSignPaymentTransaction(input) {
      if (input.network !== NETWORK || input.extra?.assetTransferMethod !== "masumi") throw new Error("Only Masumi escrow offers on preprod are supported.");
      const schema = validateMasumiExtra(input.extra, input.network);
      if (!schema.ok) throw new Error(`Invalid escrow terms: ${schema.detail}`);
      const masumi: CardanoExtraMasumi = schema.extra;
      // The seller signed the terms, the registry confirms the agent, price and URL.
      const { commitment, resource } = context;
      if (!resource) throw new Error("The payment offer does not name the resource it protects.");
      let registry: "checked" | "skipped" = "skipped"; // the library calls the validator only for registered offers
      const validateRegistryClaim: typeof registryValidator = claim => { registry = "checked"; return registryValidator(claim); };
      const authorization = await verifyMasumiAuthorization(masumi, {
        scheme: "exact", network: input.network, asset: input.asset, amount: input.amount,
        payTo: input.payTo, maxTimeoutSeconds: input.maxTimeoutSeconds, extra: input.extra,
      }, { requireAllPartContent: true, validateRegistryClaim, resource });
      if (!authorization.ok) throw new Error(`Escrow offer rejected: ${authorization.reason}`);
      // The library checks the commitment is internally consistent; we check it is our job.
      const parts = masumi.inputCommitment.parts;
      if (parts.length !== 1 || JSON.stringify(parts[0].content) !== JSON.stringify(commitment)) {
        throw new Error("The escrow offer commits to a different job than the one you asked for.");
      }
      context.onVerified({ termsDigest: authorization.termsDigest, registry });

      // (c) The lock. One wallet input is the x402 nonce: it must be spent by
      // this transaction, so the facilitator can reject replays, and its owner
      // becomes the datum's buyer (who gets refunds and the deposit back).
      const utxos = await client.getWalletUtxos();
      if (!utxos.length) throw new Error("Your wallet has no inputs. Fund it with tADA and Masumi tUSDM.");
      const nonceInput = utxos[0];
      if (Address.toHex(nonceInput.address) === Address.toHex(Address.fromBech32(masumi.terms.sellerAddress))) {
        throw new Error("Use a buyer wallet that is not the seller's.");
      }
      const response = await fetch(`${blockfrost.baseUrl}/epochs/latest/parameters`, { headers: { project_id: blockfrost.projectId } });
      const { coins_per_utxo_size } = await response.json() as { coins_per_utxo_size: string };
      // buildMasumiLock returns the 19-field vested_pay datum and the lovelace to
      // lock: the price if in lovelace, plus collateral_return_lovelace (0 when
      // the price covers min-UTxO; refunded to the buyer at collect).
      const lock = buildMasumiLock(masumi, Address.toBech32(nonceInput.address), input.asset, BigInt(input.amount), BigInt(coins_per_utxo_size));

      // Say what is missing in plain terms instead of a coin-selection error.
      let output: Assets.Assets;
      if (input.asset === LOVELACE_ASSET) {
        // lockedLovelace = price + collateral (0 if the price covers min-UTxO; else returned at collect).
        output = Assets.fromLovelace(lock.lockedLovelace);
        const held = utxos.reduce((sum, u) => sum + Assets.lovelaceOf(u.assets), 0n);
        if (held < lock.lockedLovelace + 2_000_000n) {
          throw new Error(`Your wallet holds ${ada(held)}; this job locks ${ada(lock.lockedLovelace)} (price plus a refundable deposit) and needs about 2 tADA for fees.`);
        }
      } else {
        const { policyId, assetNameHex } = parseAssetUnit(input.asset);
        output = Assets.addByHex(Assets.fromLovelace(lock.lockedLovelace), policyId, assetNameHex, BigInt(input.amount));
        const held = utxos.reduce((sum, u) => sum + Assets.getByUnit(u.assets, policyId + assetNameHex), 0n);
        if (held < BigInt(input.amount)) {
          const which = policyId === TUSDM_POLICY_ID ? "Masumi tUSDM" : "the price token";
          throw new Error(`Your wallet holds ${formatTusdm(held)} of ${which} (policy ${policyId.slice(0, 8)}…); this job costs ${formatTusdm(input.amount)}. Note: preprod has another "tUSDM" (policy e675b46e…) that does not count.`);
        }
      }
      context.onBuilt({
        nonce: ref(nonceInput), datum: parseMasumiLockDatum(lock.datum.data), validTo: masumi.terms.payByTime,
        output: { lovelace: lock.lockedLovelace.toString(), asset: input.asset, amount: input.amount },
      });
      // (d) One output to the escrow with an inline datum. The validity upper
      // bound is pay_by_time, so an unbroadcast lock simply expires.
      // autoMinUtxo is off: the facilitator requires the output's lovelace to be
      // exactly (lovelace price +) collateral_return_lovelace.
      const built = await client.newTx().collectFrom({ inputs: [nonceInput] })
        .payToAddress({ address: Address.fromBech32(input.payTo), assets: output, datum: lock.datum })
        .setValidity({ to: BigInt(masumi.terms.payByTime) })
        .build({ changeAddress: await client.address(), availableUtxos: utxos, autoMinUtxo: false });
      // The wallet returns only witnesses; merge them into the full transaction.
      const unsigned = await built.toTransaction();
      const signed = await built.sign();
      const transaction = new Transaction.Transaction({ body: unsigned.body, witnessSet: signed.witnessSet, isValid: true, auxiliaryData: unsigned.auxiliaryData });
      return { transaction: Buffer.from(Transaction.toCBORBytes(transaction)).toString("base64"), nonce: ref(nonceInput) };
    },
  };
}
