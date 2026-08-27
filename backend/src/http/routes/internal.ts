import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../../db/client.js';

/**
 * Internal plane — workers only. Per-step scoped token: a worker token can
 * only write its own step's rows, and expires when the step ends (the runner
 * nulls the hash on finalize).
 */

async function authorizeStep(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<boolean> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    await reply.code(401).send({ error: { code: 'unauthorized', message: 'missing worker token' } });
    return false;
  }
  const hash = createHash('sha256').update(auth.slice(7)).digest('hex');
  const res = await query<{ id: string }>(
    `select id from step_runs
     where id = $1 and internal_token_hash = $2 and internal_token_expires_at > now()`,
    [req.params.id, hash],
  );
  if (!res.rows[0]) {
    await reply.code(403).send({ error: { code: 'forbidden', message: 'token does not match this step' } });
    return false;
  }
  return true;
}

export async function internalRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string }; Body: { events?: unknown[] } }>(
    '/internal/steps/:id/logs',
    async (req, reply) => {
      if (!(await authorizeStep(req, reply))) return;
      const events = req.body?.events;
      if (!Array.isArray(events) || events.length === 0) {
        return reply.code(422).send({ error: { code: 'validation', message: '{events: [...]} required' } });
      }
      await query(
        `insert into step_logs (step_run_id, event)
         select $1, value from jsonb_array_elements($2::jsonb)`,
        [req.params.id, JSON.stringify(events.slice(0, 500))],
      );
      return { appended: events.length };
    },
  );

  app.post<{ Params: { id: string }; Body: { totalCostUsd?: number } }>(
    '/internal/steps/:id/cost',
    async (req, reply) => {
      if (!(await authorizeStep(req, reply))) return;
      const cost = Number(req.body?.totalCostUsd);
      if (!Number.isFinite(cost) || cost < 0) {
        return reply.code(422).send({ error: { code: 'validation', message: '{totalCostUsd: number} required' } });
      }
      await query('update step_runs set cost_usd = $2 where id = $1', [req.params.id, cost]);
      return { ok: true };
    },
  );
}
