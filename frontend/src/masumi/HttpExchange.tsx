/** One HTTP exchange, network-panel style: request line, status, headers (x402 ones decoded) and bodies. */
import { decodeX402Headers, STATUS_TEXT, type HttpLog } from "./http.js";
import { JsonTree } from "./JsonTree.js";
import { shortMiddle } from "./format.js";
import { Copy } from "./Value.js";

const X402_HEADER_NOTE: Record<string, string> = {
  "payment-required": "The seller's offer: price, escrow address and signed Masumi terms (base64 JSON).",
  "payment-signature": "The buyer's signed escrow transaction and the accepted offer (base64 JSON).",
  "payment-response": "The settlement receipt from the facilitator (base64 JSON).",
};

function Headers({ headers, now }: { headers: Record<string, string>; now: number }) {
  const decoded = decodeX402Headers(headers);
  const entries = Object.entries(headers);
  if (!entries.length) return <p className="muted small">No headers of interest.</p>;
  return (
    <dl className="http-headers">
      {entries.map(([name, value]) => {
        const x402 = decoded[name.toLowerCase()];
        return (
          <div key={name} className={x402 !== undefined ? "x402-header" : ""}>
            <dt>{name}</dt>
            <dd>
              <span className="mono">{shortMiddle(value, 24)}</span>{value.length > 49 && <Copy text={value} />}
              {x402 !== undefined && (
                <details className="decoded" open>
                  <summary>Decoded. {X402_HEADER_NOTE[name.toLowerCase()]}</summary>
                  <JsonTree data={x402} now={now} />
                </details>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function HttpExchangeView({ log, now, responseFirst }: { log: HttpLog; now: number; responseFirst?: boolean }) {
  const e = log.latest;
  const status = e.status ?? 0;
  const tone = e.pending ? "wait" : e.error ? "err" : status >= 500 ? "err" : status === 402 ? "pay" : status >= 400 ? "warn" : "ok";
  return (
    <div className="http">
      <div className="http-line">
        <span className={`method m-${e.method.toLowerCase()}`}>{e.method}</span>
        <code className="http-path" title={e.url}>{e.url.replace(/[0-9a-f]{24,}/g, hex => shortMiddle(hex, 8))}</code>
        <span className={`status s-${tone}`}>{e.pending ? "pending…" : e.error ? "network error" : `${status} ${e.statusText || STATUS_TEXT[status] || ""}`}</span>
        {e.pending ? <span className="http-ms">{(Math.max(0, now - e.at) / 1000).toFixed(0)} s</span> : e.ms !== undefined && <span className="http-ms">{e.ms} ms</span>}
      </div>
      {log.count > 1 && <p className="muted small">Polled {log.count}×; the latest exchange is shown.</p>}
      <div className={`http-parts ${responseFirst ? "response-first" : ""}`}>
      <section className="http-part">
        <h3>Request</h3>
        <Headers headers={e.requestHeaders} now={now} />
        {e.requestBody !== undefined && <><h4>Body</h4><JsonTree data={e.requestBody} now={now} /></>}
      </section>
      <section className="http-part">
        <h3>Response</h3>
        {e.pending ? <p className="muted small">Waiting for the response. For the paid request the facilitator is broadcasting and waiting for a confirmation.</p> : e.error ? <p className="error">{e.error}</p> : (
          <>
            <Headers headers={e.responseHeaders} now={now} />
            {e.responseBody !== undefined && <><h4>Body</h4>{typeof e.responseBody === "object" ? <JsonTree data={e.responseBody} now={now} /> : <pre className="code">{String(e.responseBody)}</pre>}</>}
          </>
        )}
      </section>
      </div>
    </div>
  );
}
