import type { ReactNode } from "react";
import { Footer } from "./Footer";

/**
 * The long-form explanation of a tab, folded so the dashboard fits one
 * screen. Nothing was cut: the thesis, the cast of actors and the reference
 * links all live here.
 */
export function About({ children }: { children: ReactNode }) {
  return (
    <details className="about">
      <summary className="about__summary">About this demo</summary>
      <div className="about__body">
        {children}
        <Footer />
      </div>
    </details>
  );
}
