/**
 * A minimal Sokosumi API client for hiring this agent with Sokosumi credits.
 * Sokosumi then calls our MIP-003 `start_job` and its payment node locks the
 * funds, exactly as a Soko Bot hire would. Used only by the operator proxy in
 * agent.ts; the API key never reaches the browser.
 */
export type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>;

/** What the UI may see of a Sokosumi job. */
export interface SokosumiJob { id: string; status: string; result: string | null; name: string | null }

export function createSokosumi(config: { baseUrl: string; apiKey: string; agentName: string; agentId?: string; organizationSlug?: string; fetch?: Fetch }) {
  const fetchImpl = config.fetch ?? (fetch as unknown as Fetch);
  let resolvedAgentId = config.agentId;

  /** Calls the API and unwraps Sokosumi's `{ data, meta }` envelope. */
  async function call<T>(method: string, path: string, body?: unknown): Promise<{ data: T; meta?: { pagination?: { nextCursor?: string | null } } }> {
    const response = await fetchImpl(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(config.organizationSlug ? { "X-Organization-Slug": config.organizationSlug } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 300);
      throw Object.assign(new Error(`Sokosumi ${method} ${path} returned ${response.status}${detail ? `: ${detail}` : ""}`), { status: response.status });
    }
    const json = await response.json() as { data?: T; meta?: { pagination?: { nextCursor?: string | null } } };
    if (!json || typeof json !== "object" || !("data" in json)) throw new Error(`Sokosumi ${method} ${path} returned an unexpected shape.`);
    return json as { data: T; meta?: { pagination?: { nextCursor?: string | null } } };
  }

  const notShown = (error: unknown) => (error as { status?: number }).status === 404
    ? new Error(`Sokosumi does not show "${config.agentName}" to your account. It is not listed yet or it is hidden (see README, "From Sokosumi").`)
    : error;

  /** Sokosumi's id for this agent: SOKOSUMI_AGENT_ID, or a unique exact AGENT_NAME match in the catalog. */
  async function agentId(): Promise<string> {
    if (resolvedAgentId) return resolvedAgentId;
    const matches: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await call<Array<{ id: string; name: string }>>("GET", `/agents?kind=cardano&limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      for (const agent of page.data) if (agent.name === config.agentName) matches.push(agent.id);
      cursor = page.meta?.pagination?.nextCursor;
    } while (cursor);
    if (matches.length === 0) throw new Error(`"${config.agentName}" is not listed in the Sokosumi catalog for your account (not synced yet, or hidden).`);
    if (matches.length > 1) throw new Error(`Several Sokosumi agents are named "${config.agentName}". Set SOKOSUMI_AGENT_ID to yours: ${matches.join(", ")}`);
    return (resolvedAgentId = matches[0]);
  }

  const pick = (job: SokosumiJob): SokosumiJob => ({ id: job.id, status: job.status, result: job.result ?? null, name: job.name ?? null });

  return {
    agentId,
    /** Creates a Sokosumi job for this agent with the given text; `maxCredits` caps the price. */
    async hire(text: string, maxCredits?: number): Promise<SokosumiJob> {
      const id = await agentId();
      try {
        const { data: inputSchema } = await call<unknown>("GET", `/agents/${id}/input-schema`);
        const { data } = await call<SokosumiJob>("POST", `/agents/${id}/jobs`, {
          // A name spares Sokosumi from generating one before it calls start_job.
          name: `Demo UI: ${text.slice(0, 60)}`, inputSchema, inputData: { text }, ...(maxCredits ? { maxCredits } : {}),
        });
        return pick(data);
      } catch (error) { throw notShown(error); }
    },
    /** The job's status and result. */
    job: async (jobId: string) => pick((await call<SokosumiJob>("GET", `/jobs/${encodeURIComponent(jobId)}`)).data),
  };
}

/** Where a Sokosumi job stands, for the UI rail. Unknown statuses are terminal, so polling always ends. */
export type SokosumiStage = "paying" | "working" | "done" | "stopped";
export function sokosumiStage(status: string): SokosumiStage {
  switch (status) {
    case "payment_pending": return "paying";
    case "started": case "processing": case "result_pending": return "working";
    case "completed": return "done";
    default: return "stopped"; // failed, payment_failed, input_required, refund_*, dispute_*, or anything new
  }
}
