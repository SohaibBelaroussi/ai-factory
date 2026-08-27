/**
 * Worker-side clients: the internal API (rows — logs, cost) and the Inngest
 * event API (control flow). Events drive control flow, rows drive
 * observability — the split from backend-api.md.
 */

type Ctx = { internalUrl: string; internalToken: string; stepRunId: string; inngestEventUrl: string };

async function post(url: string, body: unknown, headers: Record<string, string> = {}): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export class InternalApi {
  constructor(private readonly ctx: Ctx) {}

  private queue: unknown[] = [];
  private timer: NodeJS.Timeout | null = null;

  /** Batched, best-effort log streaming. Logging must never crash the step. */
  pushLog(event: unknown): void {
    this.queue.push(event);
    if (this.queue.length >= 25) void this.flushLogs();
    else if (!this.timer) {
      this.timer = setTimeout(() => void this.flushLogs(), 1500);
      this.timer.unref?.();
    }
  }

  async flushLogs(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    await post(
      `${this.ctx.internalUrl}/internal/steps/${this.ctx.stepRunId}/logs`,
      { events: batch },
      { authorization: `Bearer ${this.ctx.internalToken}` },
    );
  }

  async postCost(totalCostUsd: number): Promise<void> {
    await post(
      `${this.ctx.internalUrl}/internal/steps/${this.ctx.stepRunId}/cost`,
      { totalCostUsd },
      { authorization: `Bearer ${this.ctx.internalToken}` },
    );
  }

  /** Emit the step's ONE event to Inngest. Retries; this must not be lost. */
  async emitEvent(name: string, data: Record<string, unknown>): Promise<void> {
    for (let i = 0; i < 4; i++) {
      if (await post(this.ctx.inngestEventUrl, { name, data })) return;
      await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
    }
    console.error(`FATAL: could not emit ${name} to Inngest after 4 attempts`);
  }
}
