import { ACTORS } from "../lib/actors";
import { About } from "./About";

/**
 * The Transactions tab's intro: the thesis in one line, the testnet note,
 * and everything longer folded into "About this demo".
 */
export function Hero() {
  return (
    <header className="intro">
      <p className="intro__kicker">x402 protocol demo</p>
      <h1 className="intro__headline">402 isn&rsquo;t an error. It&rsquo;s an invoice.</h1>
      <p className="intro__lede">
        Pay for one HTTP resource with a Cardano wallet and watch each protocol step.
      </p>
      <p className="intro__note">
        Testnet ADA on <strong>Cardano preprod</strong> only — worth nothing.{" "}
        <a href="https://docs.cardano.org/cardano-testnets/tools/faucet/" target="_blank" rel="noreferrer">
          Preprod faucet ↗
        </a>
      </p>
      <About>
        <p>
          <strong>x402</strong> turns HTTP&rsquo;s oldest unused status code into a machine-to-machine payment rail. A
          client asks for a resource, the server names its price, a wallet pays exactly that price on-chain, and the
          resource unlocks — no accounts, no API keys, nothing to reconcile afterward.
        </p>
        <ul className="legend">
          {ACTORS.map((actor) => (
            <li key={actor.id} className="legend__item">
              <span className="legend__label">{actor.label}</span>
              <span className="legend__role">{actor.role}</span>
              <span className="legend__blurb">{actor.blurb}</span>
            </li>
          ))}
        </ul>
      </About>
    </header>
  );
}
