import type { FastifyInstance, FastifyReply } from 'fastify';
import { query } from '../../db/client.js';
import { subscribe } from '../../modules/events.js';

function openSse(reply: FastifyReply): (event: string, data: unknown) => void {
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  return (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export async function eventsRoutes(app: FastifyInstance): Promise<void> {
  /**
   * One SSE stream for the whole UI: run.updated · question.created ·
   * notification.created · board.updated. Events carry ids, not payloads —
   * clients re-fetch the affected resource.
   */
  app.get('/events', async (req, reply) => {
    const send = openSse(reply);
    send('hello', { ok: true });
    const unsub = subscribe((e) => {
      if (e.channel !== 'factory_events') return;
      const { type, ...rest } = e.payload;
      if (typeof type === 'string') send(type, rest);
    });
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(heartbeat);
      unsub();
      reply.raw.end();
    });
    return reply;
  });

  /** SSE tail of step_logs for one run (live session viewer). */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(
    '/runs/:id/logs/stream',
    async (req, reply) => {
      const runId = req.params.id;
      let cursor = Number(req.query.after ?? 0);
      const send = openSse(reply);

      let draining = false;
      const drain = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          for (;;) {
            const rows = await query<{ id: string; step_index: number; attempt: number; event: unknown; ts: Date }>(
              `select l.id, s.step_index, s.attempt, l.event, l.ts
               from step_logs l join step_runs s on s.id = l.step_run_id
               where s.pipeline_run_id = $1 and l.id > $2 order by l.id limit 200`,
              [runId, cursor],
            );
            if (rows.rows.length === 0) break;
            for (const row of rows.rows) {
              cursor = Math.max(cursor, Number(row.id));
              send('log', row);
            }
          }
        } finally {
          draining = false;
        }
      };

      await drain();
      const unsub = subscribe((e) => {
        if (e.channel === 'step_logs') void drain();
      });
      const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 25_000);
      req.raw.on('close', () => {
        clearInterval(heartbeat);
        unsub();
        reply.raw.end();
      });
      return reply;
    },
  );
}
