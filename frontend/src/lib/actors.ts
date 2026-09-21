export type Actor = "you" | "seller" | "facilitator" | "chain";

export interface ActorInfo {
  id: Actor;
  label: string;
  role: string;
  /** One sentence, used in the hero's actor legend. */
  blurb: string;
}

/** Shared metadata for the four parties the ActorRail visualizes — the hero
 * legend and the rail diagram both read from this one table so the two never drift. */
export const ACTORS: ActorInfo[] = [
  {
    id: "you",
    label: "You",
    role: "Cardano wallet",
    blurb: "Holds the funds and signs the transaction. Nothing leaves your wallet until you approve it.",
  },
  {
    id: "seller",
    label: "Seller",
    role: "Resource server",
    blurb: "Names a price for one HTTP resource and never touches your money directly.",
  },
  {
    id: "facilitator",
    label: "Facilitator",
    role: "Verifies + settles",
    blurb: "Checks the signed transaction, submits it, and reports settlement back to the seller.",
  },
  {
    id: "chain",
    label: "Cardano",
    role: "Preprod ledger",
    blurb: "Where the payment actually settles — a public ledger, not a database row.",
  },
];
