import { useCallback, useEffect, useState } from "react";
import { useWallet } from "./lib/useWallet";
import { TabNav, type TabInfo } from "./components/TabNav";
import { TransactionsTab } from "./tabs/TransactionsTab";
import { MasumiTab } from "./tabs/MasumiTab";

type TabId = "transactions" | "masumi";

const TABS: TabInfo<TabId>[] = [
  { id: "transactions", label: "Transactions", detail: "Pay for an HTTP resource with x402" },
  { id: "masumi", label: "Masumi agent", detail: "Hire an AI agent, paid through escrow" },
];

const fromHash = (): TabId => (window.location.hash === "#masumi" ? "masumi" : "transactions");
const BLOCKFROST = {
  baseUrl: "https://cardano-preprod.blockfrost.io/api/v0",
  projectId: import.meta.env.VITE_BLOCKFROST_PROJECT_ID as string,
};
/** Writes the tab into the URL without adding a history entry. */
const showInUrl = (tab: TabId) =>
  window.history.replaceState(null, "", tab === "masumi" ? "#masumi" : window.location.pathname + window.location.search);

/**
 * The page shell: one wallet connection and one top bar for two demos. The
 * selected tab lives in the URL hash (#masumi), so it can be linked and
 * survives a reload. Only the selected tab is mounted.
 */
export default function App() {
  const wallet = useWallet(BLOCKFROST);
  const [tab, setTab] = useState<TabId>(fromHash);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // While a payment runs, the tab stays put and the URL is put back to match it.
    const onHash = () => { if (busy) showInUrl(tab); else setTab(fromHash()); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [busy, tab]);

  function select(next: TabId) {
    if (busy || next === tab) return;
    setTab(next);
    showInUrl(next);
  }
  const onBusyChange = useCallback((next: boolean) => setBusy(next), []);

  return (
    <div className="app">
      <header className="topbar">
        <span className="topbar__brand"><strong>x402</strong> on Cardano</span>
        <TabNav tabs={TABS} current={tab} onChange={select}
          lockedReason={busy ? "Payment in progress: finish it before switching." : undefined} />
        <span className="topbar__net" title="Every transaction here uses the Cardano preprod testnet">
          <span className="topbar__net-dot" aria-hidden="true" />preprod
        </span>
      </header>
      <main className="workspace">
        <div className="workspace__panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab === "transactions"
            ? <TransactionsTab wallet={wallet} onBusyChange={onBusyChange} />
            : <MasumiTab wallet={wallet} onBusyChange={onBusyChange} />}
        </div>
      </main>
    </div>
  );
}
