const SNIPPET = `import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";

const core = new x402Client();
const http = new x402HTTPClient(core);`;

/**
 * The published core and HTTP clients own the protocol encoding that the
 * timeline makes visible.
 */
export function CodeAside() {
  return (
    <aside className="code-aside">
      <p className="code-aside__eyebrow">Published client APIs</p>
      <pre className="artifact artifact--code">
        <code>{SNIPPET}</code>
      </pre>
      <p className="code-aside__caption">
        <code>x402HTTPClient</code> parses the 402 headers and encodes the signed payment. This page keeps those
        operations separate so you can inspect each protocol artifact.
      </p>
    </aside>
  );
}
