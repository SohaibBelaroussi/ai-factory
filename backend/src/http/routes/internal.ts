import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { query } from '../../db/client.js';
import { config } from '../../config.js';
import { notify } from '../../modules/notify.js';
import type { PipelineDefinition } from '../../domain/types.js';

function sessionStorePath(stepRunId: string): string {
  return join(config.sessionStoreDir, 'steps', `${stepRunId}.json`);
}

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
      // Accumulate: suspend/resume slices each post their own session cost.
      await query('update step_runs set cost_usd = coalesce(cost_usd, 0) + $2 where id = $1', [
        req.params.id,
        cost,
      ]);
      return { ok: true };
    },
  );

  /**
   * ask_human handler target: creates the Question row, enforces the cap,
   * flips step + run to waiting-human, writes the notification. The worker
   * suspends right after this returns.
   */
  app.post<{
    Params: { id: string };
    Body: { kind?: string; body?: string; choices?: string[]; sessionId?: string };
  }>('/internal/steps/:id/question', async (req, reply) => {
    if (!(await authorizeStep(req, reply))) return;
    const body = req.body?.body;
    if (typeof body !== 'string' || body.trim() === '') {
      return reply.code(422).send({ error: { code: 'validation', message: '{body} required' } });
    }
    const stepRow = await query<{
      pipeline_run_id: string;
      step_index: number;
      ask_human_count: number;
      definition_snapshot: PipelineDefinition;
    }>(
      `select s.pipeline_run_id, s.step_index, s.ask_human_count, r.definition_snapshot
       from step_runs s join pipeline_runs r on r.id = s.pipeline_run_id where s.id = $1`,
      [req.params.id],
    );
    const row = stepRow.rows[0]!;
    const stepDef = row.definition_snapshot.steps[row.step_index];
    if (!stepDef?.allowedTools.includes('ask_human')) {
      return reply.code(403).send({ error: { code: 'not_granted', message: 'ask_human is not granted to this step' } });
    }
    if (row.ask_human_count >= stepDef.askHumanCap) {
      return reply.code(409).send({ error: { code: 'cap_exceeded', message: `ask_human cap (${stepDef.askHumanCap}) reached` } });
    }

    const kind = req.body?.kind === 'multiple-choice' ? 'multiple-choice' : 'text';
    const q = await query<{ id: string }>(
      `insert into questions (pipeline_run_id, step_run_id, kind, body, choices)
       values ($1, $2, $3, $4, $5) returning id`,
      [row.pipeline_run_id, req.params.id, kind, body.trim(), req.body?.choices ? JSON.stringify(req.body.choices) : null],
    );
    const questionId = q.rows[0]!.id;
    await query(
      `update step_runs set ask_human_count = ask_human_count + 1, status = 'waiting-human',
         harness_session_id = coalesce($2, harness_session_id) where id = $1`,
      [req.params.id, req.body?.sessionId ?? null],
    );
    await query(`update pipeline_runs set status = 'waiting-human' where id = $1 and status = 'running'`, [
      row.pipeline_run_id,
    ]);
    await notify({
      event: 'waiting-human',
      pipelineRunId: row.pipeline_run_id,
      questionId,
      summary: body.trim().slice(0, 300),
    });
    return { questionId, remaining: stepDef.askHumanCap - row.ask_human_count - 1 };
  });

  /** Suspend: the worker hands over its session JSONL (opaque blob, never parsed). */
  app.post<{ Params: { id: string }; Body: { sessionId?: string; jsonl?: string } }>(
    '/internal/steps/:id/session',
    { bodyLimit: 128 * 1024 * 1024 },
    async (req, reply) => {
      if (!(await authorizeStep(req, reply))) return;
      const { sessionId, jsonl } = req.body ?? {};
      if (!sessionId || typeof jsonl !== 'string' || jsonl === '') {
        return reply.code(422).send({ error: { code: 'validation', message: '{sessionId, jsonl} required' } });
      }
      const file = sessionStorePath(req.params.id);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, JSON.stringify({ sessionId, jsonl }), 'utf8');
      return { stored: true };
    },
  );

  /** Resume: a fresh worker fetches the suspended session back. */
  app.get<{ Params: { id: string } }>('/internal/steps/:id/session', async (req, reply) => {
    if (!(await authorizeStep(req, reply))) return;
    try {
      const raw = await readFile(sessionStorePath(req.params.id), 'utf8');
      return JSON.parse(raw) as { sessionId: string; jsonl: string };
    } catch {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no stored session for this step' } });
    }
  });
}
