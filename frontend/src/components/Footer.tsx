export function Footer() {
  return (
    <footer className="footer">
      <p>
        x402 on Cardano preprod — a protocol demo, not a product. Read the{" "}
        <a
          href="https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/cardano"
          target="_blank"
          rel="noreferrer"
        >
          Cardano package guide
        </a>{" "}
        or explore blocks on{" "}
        <a href="https://preprod.cardanoscan.io/" target="_blank" rel="noreferrer">
          Cardanoscan
        </a>{" "}
        or get test ADA from the{" "}
        <a href="https://docs.cardano.org/cardano-testnets/tools/faucet/" target="_blank" rel="noreferrer">
          preprod faucet
        </a>
        .
      </p>
    </footer>
  );
}
