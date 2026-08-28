/**
 * SSE over fetch. EventSource can't POST (the chat turn stream is SSE on a
 * POST) and can't send an Authorization header (needed once OPERATOR_TOKEN is
 * set on the VM) — so one fetch-streaming helper serves every stream in the
 * app: /events, /runs/:id/logs/stream, and chat turns.
 */

export type SseMessage = { event: string; data: string };

export async function streamSse(
  url: string,
  opts: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    onMessage: (msg: SseMessage) => void;
  },
): Promise<void> {
  const res = await fetch(url, {
    method: opts.method ?? 'GET',
    headers: { accept: 'text/event-stream', ...opts.headers },
    body: opts.body,
    signal: opts.signal,
  });
  if (!res.ok || !res.body) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      if (body.error?.message) detail = body.error.message;
    } catch {
      // non-JSON error body; keep the status line
    }
    throw new Error(`stream failed: ${detail}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let event = 'message';
  let data: string[] = [];

  const dispatch = (): void => {
    if (data.length > 0) opts.onMessage({ event, data: data.join('\n') });
    event = 'message';
    data = [];
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line === '') dispatch();
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      // ':' comments (keepalives) and id:/retry: fields are ignored
    }
  }
  dispatch();
}

/**
 * Long-lived stream with auto-reconnect and exponential backoff.
 * Returns a stop function. `makeUrl` is re-evaluated on every (re)connect so
 * cursor-style streams (?after=N) resume where they left off.
 */
export function persistentSse(
  makeUrl: () => string,
  opts: {
    headers?: () => Record<string, string>;
    onMessage: (msg: SseMessage) => void;
    onStatus?: (status: 'connecting' | 'open' | 'down') => void;
  },
): () => void {
  const ctrl = new AbortController();
  let stopped = false;
  let backoff = 1000;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      opts.onStatus?.('connecting');
      try {
        let opened = false;
        await streamSse(makeUrl(), {
          headers: opts.headers?.(),
          signal: ctrl.signal,
          onMessage: (msg) => {
            if (!opened) {
              opened = true;
              backoff = 1000;
              opts.onStatus?.('open');
            }
            opts.onMessage(msg);
          },
        });
      } catch {
        // fall through to backoff (abort exits via `stopped`)
      }
      if (stopped) return;
      opts.onStatus?.('down');
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 15_000);
    }
  };
  void loop();

  return () => {
    stopped = true;
    ctrl.abort();
  };
}
