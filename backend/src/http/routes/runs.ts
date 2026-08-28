import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client.js';
import { spawnRun, cancelRun, RefusalError } from '../../modules/commands.js';
import { NotReadyError } from '../../modules/health.js';
import { readRunArtifact } from '../../modules/artifacts.js';
import { listRuns } from '../../modules/projections.js';
import type { PipelineRunRow, StepRunRow } from '../../domain/types.js';

export async function runsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: { pipeline?: string; issueNumber?: number; brief?: string; force?: boolean };
    Headers: { 'idempotency-key'?: string };
  }>('/runs', async (req, reply) => {
    try {
      const { pipeline, issueNumber, brief, force } = req.body ?? {};
      if (!pipeline || !brief) {
        return reply.code(422).send({
          error: { code: 'validation', message: 'Body must include {pipeline, brief}' },
        });
      }
      const result = await spawnRun({
        pipeline,
        issueNumber: issueNumber ?? null,
        brief,
        force,
        createdBy: 'api',
        idempotencyKey: req.headers['idempotency-key'],
      });
      return reply.code(result.existing ? 200 : 201).send({ runId: result.runId });
    } catch (err) {
      if (err instanceof RefusalError) return reply.code(409).send(err.refusal);
      if (err instanceof NotReadyError) {
        return reply.code(503).send({
          error: { code: 'not_ready', message: 'Factory is not ready to dispatch', details: err.health.checks },
        });
      }
      throw err;
    }
  });

  app.get<{ Querystring: { active?: string; limit?: string } }>('/runs', async (req) =>
    listRuns(req.query.active === 'true', Number(req.query.limit ?? 50)),
  );

  app.get<{ Params: { id: string } }>('/runs/:id', async (req, reply) => {
    const runs = await query<PipelineRunRow>('select * from pipeline_runs where id = $1', [
      req.params.id,
    ]);
    const run = runs.rows[0];
    if (!run) return reply.code(404).send({ error: { code: 'not_found', message: 'no such run' } });
    const steps = await query<StepRunRow>(
      `select * from step_runs where pipeline_run_id = $1 order by created_at`,
      [run.id],
    );
    const questions = await query(
      `select id, step_run_id, kind, body, choices, answer, status, created_at, answered_at
       from questions where pipeline_run_id = $1 order by created_at`,
      [run.id],
    );
    return {
      id: run.id,
      pipeline: run.pipeline_name,
      issueNumber: run.issue_number,
      branch: run.branch,
      brief: run.brief,
      status: run.status,
      currentStepIndex: run.current_step_index,
      createdBy: run.created_by,
      createdAt: run.created_at,
      endedAt: run.ended_at,
      costUsd: run.cost_usd,
      definition: run.definition_snapshot,
      steps: steps.rows.map((s) => ({
        id: s.id,
        index: s.step_index,
        name: run.definition_snapshot.steps[s.step_index]?.name ?? 'unknown',
        attempt: s.attempt,
        status: s.status,
        verdict: s.verdict,
        commitShas: s.commit_shas,
        costUsd: s.cost_usd,
        sessionId: s.harness_session_id,
        startedAt: s.started_at,
        endedAt: s.ended_at,
      })),
      questions: questions.rows,
    };
  });

  app.post<{ Params: { id: string } }>('/runs/:id/cancel', async (req, reply) => {
    try {
      await cancelRun(req.params.id);
      return { cancelled: true };
    } catch (err) {
      if (err instanceof RefusalError) return reply.code(409).send(err.refusal);
      throw err;
    }
  });

  app.get<{ Params: { id: string; name: string } }>(
    '/runs/:id/artifacts/:name',
    async (req, reply) => {
      if (!/^[\w][\w.-]*$/.test(req.params.name)) {
        return reply.code(422).send({ error: { code: 'validation', message: 'bad artifact name' } });
      }
      const content = await readRunArtifact(req.params.id, req.params.name);
      if (content === null) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'artifact not found (archive or branch)' } });
      }
      return reply.type('text/plain; charset=utf-8').send(content);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { step?: string; after?: string; limit?: string } }>(
    '/runs/:id/logs',
    async (req) => {
      const after = Number(req.query.after ?? 0);
      const limit = Math.min(Number(req.query.limit ?? 200), 1000);
      const stepFilter = req.query.step !== undefined ? Number(req.query.step) : null;
      const rows = await query(
        `select l.id, l.step_run_id, s.step_index, s.attempt, l.event, l.ts
         from step_logs l join step_runs s on s.id = l.step_run_id
         where s.pipeline_run_id = $1 and l.id > $2
           and ($3::int is null or s.step_index = $3)
         order by l.id limit $4`,
        [req.params.id, after, stepFilter, limit],
      );
      return rows.rows;
    },
  );
}
