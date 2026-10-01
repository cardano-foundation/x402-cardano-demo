/**
 * Seller-side transactions on Cardano preprod (Evolution SDK), built from the
 * vendored Masumi blueprints:
 *
 *   register / deregister   mint or burn the registry V2 NFT
 *   submitResult            vested_pay redeemer 5: FundsLocked -> ResultSubmitted
 *   collectAll              vested_pay redeemer 0: withdraw after unlock_time
 *
 * Every transaction is evaluated during build() (Blockfrost), so a script
 * failure throws before anything is signed, and transactions run one at a time
 * so they never compete for the seller's inputs. The rules below were checked
 * against the real validators with `aiken tx simulate`; see docs/DEVELOPER.md
 * and docs/FLOWS.md (each transaction's anatomy).
 *
 * Cardano in one paragraph, for readers new to it: money sits in UTxOs
 * (unspent transaction outputs). A transaction spends some UTxOs and creates
 * new ones. A UTxO locked at a script address can only be spent if the script
 * (here Masumi's vested_pay validator) approves, given a redeemer (the action
 * requested) and the UTxO's datum (the state stored with it). Validity bounds
 * give the script a trusted time window, since scripts cannot read a clock.
 */
import { readFileSync } from "node:fs";
import {
  Address, Assets, CBOR, Client, Data, InlineDatum, KeyHash, PlutusV3, preprod, ScriptHash, SlotConfig, Time,
  TransactionHash, TransactionInput, UPLC, type TransactionMetadatum, type UTxO,
} from "@evolution-sdk/evolution";
import { MASUMI_DEFAULT_DEPLOYMENT, parseMasumiLockDatum, type MasumiDatumView } from "@x402/cardano";
import { ESCROW_ADDRESS, paymentKeyHash, REGISTRY_POLICY_ID, TUSDM_UNIT } from "./constants.js";
import type { EscrowUtxo } from "./lockMatch.js";
import { registryAssetName, submitResultDatum } from "./masumi.js";
import type { Blockfrost } from "./registry.js";

// ---------------------------------------------------------------- scripts

const blueprint = (file: string) =>
  (JSON.parse(readFileSync(new URL(`../contracts/${file}`, import.meta.url), "utf8")) as { validators: Array<{ compiledCode: string }> }).validators[0].compiledCode;

/** `vested_pay(required_admins, admin_vks, cooldown_period)` with Masumi's preprod parameters. */
export function paymentScript(deployment = MASUMI_DEFAULT_DEPLOYMENT): PlutusV3.PlutusV3 {
  const applied = UPLC.applyParamsToScript(blueprint("payment-v2.plutus.json"), [
    Data.int(BigInt(deployment.requiredAdmins)),
    Data.list(deployment.adminVkeys.map(v => Data.bytearray(v))),
    Data.int(BigInt(deployment.cooldownPeriod)),
  ]);
  // applyParamsToScript returns double-CBOR; PlutusV3 wants the single-wrapped script.
  const bytes = CBOR.fromCBORHex(applied);
  if (!(bytes instanceof Uint8Array)) throw new Error("Unexpected applied script encoding.");
  return new PlutusV3.PlutusV3({ bytes });
}

/** The unparameterized registry V2 mint policy. */
export const registryScript = () => new PlutusV3.PlutusV3({ bytes: Buffer.from(blueprint("registry-v2.plutus.json"), "hex") });

/** Blake2b-224 script hash (hex), i.e. policy id or payment credential. */
export const scriptHash = (script: PlutusV3.PlutusV3) => ScriptHash.toHex(ScriptHash.fromScript(script));

// ---------------------------------------------------------------- time

const SLOT = SlotConfig.SLOT_CONFIG_NETWORK.Preprod;
/**
 * vested_pay's cooldown_period (420 000 ms on preprod). After an action, the
 * acting party must wait this long before acting again; SubmitResult sets
 * seller_cooldown_time to (validity upper bound + cooldown).
 */
const COOLDOWN_MS = BigInt(MASUMI_DEFAULT_DEPLOYMENT.cooldownPeriod);
/** The POSIX time the ledger shows scripts for a validity bound: the start of its slot. */
export const slotStartMs = (ms: bigint) => Time.slotToUnixTime(Time.unixTimeToSlot(ms, SLOT), SLOT);
/** The first slot start at or after `ms`, for lower bounds that must clear a deadline. */
export const ceilToSlotMs = (ms: bigint) => slotStartMs(ms) === ms ? ms : slotStartMs(ms) + BigInt(SLOT.slotLength);

// ---------------------------------------------------------------- helpers

/**
 * Redeemers are constructor indices of each validator's Action type:
 *   vested_pay (payment-v2): Withdraw 0, SetRefundRequested 1, AuthorizeWithdrawal 2,
 *                            WithdrawRefund 3, WithdrawDisputed 4, SubmitResult 5, AuthorizeRefund 6
 *   registry (mint policy):  MintAction 0, UpdateAction 1, BurnAction 2
 */
const REDEEMER = {
  submitResult: Data.constr(5n, []), // vested_pay SubmitResult
  withdraw: Data.constr(0n, []),     // vested_pay Withdraw
  mint: Data.constr(0n, []),         // registry MintAction
  burn: Data.constr(2n, []),         // registry BurnAction
};
const txHashOf = (u: UTxO.UTxO) => TransactionHash.toHex(u.transactionId);
const refOf = (u: { txHash: string; outputIndex: number }) => `${u.txHash}#${u.outputIndex}`;

/** Wallet UTxOs safe for coin selection and collateral: never the registry NFT, never a reference script. */
const spendable = (wallet: readonly UTxO.UTxO[]) =>
  wallet.filter(u => u.scriptRef === undefined && !Assets.getUnits(u.assets).some(unit => unit.startsWith(REGISTRY_POLICY_ID)));

/** A datum address back as a ledger address (payment + stake parts). Pointer addresses are refused upstream. */
function datumAddress(a: MasumiDatumView["buyer"]): Address.Address {
  if (a.pointer) throw new Error("Pointer stake addresses are not supported.");
  const cred = (c: { isScript: boolean; hash: string }) => c.isScript ? ScriptHash.fromHex(c.hash) : KeyHash.fromHex(c.hash);
  return new Address.Address({ networkId: 0, paymentCredential: cred(a.payment), ...(a.stake ? { stakingCredential: cred(a.stake) } : {}) });
}

/** JSON (strings ≤ 64 bytes, numbers, arrays, objects) as transaction metadata. */
function toMetadatum(v: unknown): TransactionMetadatum.TransactionMetadatum {
  if (typeof v === "string") {
    if (Buffer.byteLength(v) > 64) throw new Error(`Metadata string over 64 bytes: ${v.slice(0, 20)}…`);
    return v;
  }
  if (typeof v === "number" || typeof v === "bigint") return BigInt(v);
  if (Array.isArray(v)) return v.map(toMetadatum);
  if (v && typeof v === "object") return new Map(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toMetadatum(x)] as const));
  throw new Error(`Unsupported metadata value ${String(v)}`);
}

// ---------------------------------------------------------------- Blockfrost

type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
interface TxOutputRow { output_index: number; address: string; consumed_by_tx?: string | null; collateral?: boolean }

/** The outputs of a transaction (Blockfrost `/txs/{hash}/utxos`); `[]` if the transaction is unknown. */
export async function txOutputs(blockfrost: Blockfrost, txHash: string, fetchImpl: Fetch = fetch): Promise<TxOutputRow[]> {
  const response = await fetchImpl(`${blockfrost.baseUrl}/txs/${txHash}/utxos`, { headers: { project_id: blockfrost.projectId } });
  if (response.status === 404) return []; // never landed (yet)
  if (!response.ok) throw new Error(`Blockfrost /txs/${txHash}/utxos returned ${response.status}`);
  return (await response.json() as { outputs: TxOutputRow[] }).outputs;
}

/** Indexes of outputs that sit unspent at the escrow (not spent, not a collateral return). */
export const unspentEscrowOutputs = (rows: TxOutputRow[]) =>
  rows.filter(r => r.address === ESCROW_ADDRESS && !r.consumed_by_tx && !r.collateral).map(r => r.output_index);

// ---------------------------------------------------------------- chain

/**
 * The seller's chain client. `mnemonic` must derive `sellerAddress` (checked
 * before every transaction), the address that holds the registry NFT.
 */
export function createChain(config: { blockfrost: Blockfrost; mnemonic: string; sellerAddress: string }) {
  const client = Client.make(preprod).withBlockfrost(config.blockfrost).withSeed({ mnemonic: config.mnemonic });
  const seller = Address.fromBech32(config.sellerAddress);
  const sellerVkh = paymentKeyHash(config.sellerAddress);
  const escrow = Address.fromBech32(ESCROW_ADDRESS);

  let queue: Promise<unknown> = Promise.resolve();
  /** Runs transactions one at a time and waits for each to confirm. */
  function serial<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  }

  async function checkWallet() {
    const address = Address.toBech32(await client.address());
    if (address !== config.sellerAddress) throw new Error(`The mnemonic derives ${address}, not the seller address ${config.sellerAddress}.`);
    return spendable(await client.getWalletUtxos());
  }

  /** Chain time from the latest block; validity windows are built from it, not the local clock. */
  async function tipMs(): Promise<bigint> {
    const response = await fetch(`${config.blockfrost.baseUrl}/blocks/latest`, { headers: { project_id: config.blockfrost.projectId } });
    if (!response.ok) throw new Error(`Blockfrost /blocks/latest returned ${response.status}`);
    return BigInt((await response.json() as { time: number }).time) * 1000n;
  }

  /**
   * Signs and submits, reports the hash as soon as the node accepted it, then
   * waits for confirmation so the next queued transaction sees fresh inputs.
   */
  async function signSubmitAwait(built: { sign(): Promise<{ submit(): Promise<TransactionHash.TransactionHash> }> }, onSubmitted?: (txHash: string) => void) {
    const hash = await (await built.sign()).submit();
    onSubmitted?.(TransactionHash.toHex(hash));
    await client.awaitTx(hash, 5_000, 300_000);
    return TransactionHash.toHex(hash);
  }

  function toEscrowUtxo(u: UTxO.UTxO): EscrowUtxo {
    const tokens: Record<string, bigint> = {};
    for (const unit of Assets.getUnits(u.assets)) if (unit !== "lovelace") tokens[unit] = Assets.getByUnit(u.assets, unit);
    const datum = u.datumOption instanceof InlineDatum.InlineDatum ? parseMasumiLockDatum(u.datumOption.data) : null;
    return { txHash: txHashOf(u), outputIndex: Number(u.index), datum, lovelace: Assets.lovelaceOf(u.assets), tokens, hasReferenceScript: u.scriptRef !== undefined, raw: u };
  }

  /** Escrow UTxOs holding Masumi tUSDM: where standard-path (Sokosumi) jobs are paid. */
  const scanEscrow = async () => (await client.getUtxosWithUnit(escrow, TUSDM_UNIT)).map(toEscrowUtxo);

  /** Unspent escrow outputs of one transaction: where an x402 job's verified lock lands. */
  async function locksOfTx(txHash: string): Promise<EscrowUtxo[]> {
    const indexes = unspentEscrowOutputs(await txOutputs(config.blockfrost, txHash));
    if (!indexes.length) return [];
    const refs = indexes.map(index => new TransactionInput.TransactionInput({ transactionId: TransactionHash.fromHex(txHash), index: BigInt(index) }));
    return (await client.getUtxosByOutRef(refs)).map(toEscrowUtxo);
  }

  const rawOf = (lock: EscrowUtxo) => {
    if (!(lock.raw && typeof lock.raw === "object" && "transactionId" in lock.raw)) throw new Error(`No UTxO loaded for ${refOf(lock)}.`);
    return lock.raw as UTxO.UTxO;
  };

  /**
   * Registry mint. Anatomy:
   *   inputs     a seed UTxO of the seller, pure ADA if possible (its out-ref makes the asset name unique)
   *   mint       +1 of policy 67ab0c92… with name 10 ‖ blake2b_224(seed ref) ‖ 000000, redeemer MintAction
   *   outputs    the NFT (+ min-UTxO ADA) to the exact seller address; change to the seller
   *   metadata   label 721: { <policy>: { <assetName>: <V2 agent metadata> }, version: "1" }
   *   signers    the seller (mirrors the Payment Service's registration)
   */
  const register = (metadata: Record<string, unknown>) => serial(async () => {
    const wallet = await checkWallet();
    const seed = wallet.find(u => !Assets.hasMultiAsset(u.assets)) ?? wallet[0];
    if (!seed) throw new Error("The seller wallet has no spendable UTxO. Fund it with tADA.");
    const assetName = registryAssetName(txHashOf(seed), Number(seed.index));
    const nft = Assets.addByHex(Assets.zero, REGISTRY_POLICY_ID, assetName, 1n);
    const built = await client.newTx()
      .collectFrom({ inputs: [seed] }) // the policy derives the asset name from this input
      .attachScript({ script: registryScript() })
      .mintAssets({ assets: nft, redeemer: REDEEMER.mint })
      .payToAddress({ address: seller, assets: Assets.withLovelace(nft, 2_000_000n), autoMinUtxo: true })
      .attachMetadata({ label: 721n, metadata: toMetadatum({ [REGISTRY_POLICY_ID]: { [assetName]: metadata }, version: "1" }) })
      .addSigner({ keyHash: KeyHash.fromHex(sellerVkh) })
      .build({ changeAddress: seller, availableUtxos: wallet });
    return { txHash: await signSubmitAwait(built), agentIdentifier: REGISTRY_POLICY_ID + assetName };
  });

  /** Registry burn: spend the UTxO holding the NFT and mint −1 with redeemer BurnAction. */
  const deregister = (agentIdentifier: string) => serial(async () => {
    const wallet = await checkWallet();
    const holder = (await client.getWalletUtxos()).find(u => Assets.getByUnit(u.assets, agentIdentifier) === 1n);
    if (!holder) throw new Error(`${agentIdentifier} is not in the seller wallet.`);
    const built = await client.newTx()
      .collectFrom({ inputs: [holder] })
      .attachScript({ script: registryScript() })
      .mintAssets({ assets: Assets.addByHex(Assets.zero, REGISTRY_POLICY_ID, agentIdentifier.slice(56), -1n), redeemer: REDEEMER.burn })
      .addSigner({ keyHash: KeyHash.fromHex(sellerVkh) })
      .build({ changeAddress: seller, availableUtxos: wallet });
    return signSubmitAwait(built);
  });

  /**
   * SubmitResult: continue the lock at its own address with identical native
   * assets (lovelace may grow for min-UTxO) and a datum that differs only in
   * result_hash, seller_cooldown_time and state.
   *
   * Anatomy:
   *   inputs     the escrow UTxO (redeemer SubmitResult) + seller UTxOs for the fee
   *   outputs    exactly one continuing output at the escrow: same tokens, lovelace ≥ input,
   *              inline datum with result_hash set, seller_cooldown_time ≥ upper + cooldown,
   *              buyer_cooldown_time 0, state ResultSubmitted (1)
   *   validity   finite lower bound ≥ current seller cooldown; upper bound whose slot start
   *              is before submit_result_time
   *   signers    the seller (the datum's seller key); collateral from the seller's wallet
   */
  const submitResult = (lock: EscrowUtxo, resultHashHex: string, onSubmitted?: (sent: { txHash: string; sellerCooldownTime: bigint }) => void) => serial(async () => {
    const utxo = rawOf(lock);
    const d = lock.datum;
    if (!d || !(utxo.datumOption instanceof InlineDatum.InlineDatum)) throw new Error(`${refOf(lock)} has no vested_pay datum.`);
    if (d.state !== 0n || d.seller.payment.hash !== sellerVkh) throw new Error("Not a FundsLocked lock of this seller.");
    const now = await tipMs();
    // Lower bound: finite and at or after the input's seller cooldown (0 on a fresh lock).
    const earliest = ceilToSlotMs(d.sellerCooldownTime);
    const from = now - 60_000n > earliest ? now - 60_000n : earliest;
    // Upper bound: the validator sees slotStart(to) and requires it before submit_result_time.
    const to = [now + 300_000n, d.submitResultTime - 120_000n].reduce((a, b) => a < b ? a : b);
    if (to <= now + 30_000n || from >= to) throw new Error("The SubmitResult window has closed.");
    const sellerCooldown = slotStartMs(to) + COOLDOWN_MS;

    const wallet = await checkWallet();
    const built = await client.newTx()
      .collectFrom({ inputs: [utxo], redeemer: REDEEMER.submitResult })
      .attachScript({ script: paymentScript() })
      .payToAddress({
        address: utxo.address, assets: utxo.assets, autoMinUtxo: true,
        datum: new InlineDatum.InlineDatum({ data: submitResultDatum(utxo.datumOption.data, resultHashHex, sellerCooldown) }),
      })
      .addSigner({ keyHash: KeyHash.fromHex(sellerVkh) })
      .setValidity({ from, to })
      .build({ changeAddress: seller, availableUtxos: wallet });
    return signSubmitAwait(built, txHash => onSubmitted?.({ txHash, sellerCooldownTime: sellerCooldown }));
  });

  /**
   * Withdraw: one escrow per transaction; the buyer's collateral return goes back tagged with the lock's out-ref.
   *
   * Anatomy:
   *   inputs     the ResultSubmitted escrow UTxO (redeemer Withdraw) + seller UTxOs for the fee
   *   outputs    no output back to the escrow; if collateral_return_lovelace > 0, an output to
   *              buyer_return_address (or buyer) with ≥ that amount and an inline datum equal to
   *              the spent UTxO's OutputReference; everything else returns to the seller as change
   *   validity   lower bound rounded up to a slot ≥ unlock_time; any finite upper bound
   *   signers    the seller; collateral from the seller's wallet
   */
  const withdraw = (utxo: UTxO.UTxO, d: MasumiDatumView) => serial(async () => {
    const now = await tipMs(); // per transaction: earlier withdrawals in this run took time to confirm
    const from = ceilToSlotMs(d.unlockTime);
    const wallet = await checkWallet();
    let tx = client.newTx()
      .collectFrom({ inputs: [utxo], redeemer: REDEEMER.withdraw })
      .attachScript({ script: paymentScript() })
      .addSigner({ keyHash: KeyHash.fromHex(sellerVkh) })
      .setValidity({ from, to: now + 300_000n });
    if (d.collateralReturnLovelace > 0n) {
      tx = tx.payToAddress({
        address: datumAddress(d.buyerReturnAddress ?? d.buyer),
        assets: Assets.fromLovelace(d.collateralReturnLovelace),
        // Plutus V3 OutputReference { transaction_id, output_index } = Constr 0 [bytes, int]
        datum: new InlineDatum.InlineDatum({ data: Data.constr(0n, [Data.bytearray(txHashOf(utxo)), Data.int(utxo.index)]) }),
        autoMinUtxo: true,
      });
    }
    // The seller's share (tUSDM and remaining lovelace) returns as change.
    return signSubmitAwait(await tx.build({ changeAddress: seller, availableUtxos: wallet }));
  });

  /** Withdraws every ResultSubmitted escrow of this seller whose unlock time has passed. */
  async function collectAll(): Promise<Array<{ ref: string; txHash: string } | { ref: string; error: string }>> {
    // Every escrow UTxO (tUSDM and tADA payments). Paginated; fine for a manual command.
    const [locks, now] = await Promise.all([client.getUtxos(escrow).then(us => us.map(toEscrowUtxo)), tipMs()]);
    // Anyone can create escrow UTxOs in any state, so filter strictly before paying fees.
    const due = locks.filter(l => l.datum && l.datum.state === 1n && l.datum.resultHash !== "" && l.datum.sellerReturnAddress === null
      && l.datum.seller.payment.hash === sellerVkh && !l.datum.seller.payment.isScript
      && !l.datum.buyer.pointer && !l.datum.buyerReturnAddress?.pointer
      && l.datum.collateralReturnLovelace <= l.lovelace
      // Worth a fee: it pays tUSDM, or at least 1 tADA beyond the buyer's collateral return.
      && ((l.tokens[TUSDM_UNIT] ?? 0n) > 0n || l.lovelace - l.datum.collateralReturnLovelace >= 1_000_000n)
      && now >= ceilToSlotMs(l.datum.unlockTime));
    const results = [];
    for (const lock of due) {
      try { results.push({ ref: refOf(lock), txHash: await withdraw(rawOf(lock), lock.datum!) }); }
      catch (error) { results.push({ ref: refOf(lock), error: error instanceof Error ? error.message : String(error) }); }
    }
    return results;
  }

  return { scanEscrow, locksOfTx, submitResult, register, deregister, collectAll };
}
