import { useEffect, useRef, useState } from "react";
import type { ClientCardanoSigner } from "@x402/cardano";
import { createCip30Signer } from "../x402/cip30Signer";
import { listWallets, type Cip30WalletApi, type WalletInfo } from "./cip30";
import type { WalletConnection } from "../components/WalletPicker";

export interface Blockfrost { baseUrl: string; projectId: string }

export interface WalletState {
  wallets: WalletInfo[];
  connecting: string | null;
  connection: WalletConnection | null;
  connectError: string | null;
  select(key: string): Promise<void>;
  /** The Transactions tab's x402 signer, built once per connection. */
  signer(): ClientCardanoSigner | null;
  /** The raw CIP-30 API, for the Masumi tab's escrow signer. */
  api(): Cip30WalletApi | null;
  /** The browser's Blockfrost settings, shared by both tabs' signers. */
  blockfrost: Blockfrost;
}

/** One wallet connection for the whole page: both tabs sign with it. */
export function useWallet(blockfrost: Blockfrost): WalletState {
  const [wallets, setWallets] = useState<WalletInfo[]>(() => listWallets());
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connection, setConnection] = useState<WalletConnection | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const signerRef = useRef<ClientCardanoSigner | null>(null);
  const apiRef = useRef<Cip30WalletApi | null>(null);

  // Extensions inject window.cardano shortly after load.
  useEffect(() => {
    const id = window.setTimeout(() => setWallets(listWallets()), 300);
    return () => window.clearTimeout(id);
  }, []);

  async function select(key: string) {
    signerRef.current = null;
    apiRef.current = null;
    setConnection(null);
    setConnecting(key);
    setConnectError(null);
    try {
      const wallet = window.cardano?.[key];
      if (!wallet) throw new Error("That wallet is no longer available. Reload and try again.");
      const api = await wallet.enable();
      const networkId = await api.getNetworkId();
      if (networkId !== 0) {
        throw new Error("This wallet is on Cardano mainnet. Switch it to preprod and connect again.");
      }
      const signer = await createCip30Signer(api, blockfrost);
      signerRef.current = signer;
      apiRef.current = api;
      setConnection({ key, address: signer.getAddress(), networkId });
    } catch (error) {
      signerRef.current = null;
      apiRef.current = null;
      setConnection(null);
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(null);
    }
  }

  return { wallets, connecting, connection, connectError, select, signer: () => signerRef.current, api: () => apiRef.current, blockfrost };
}
