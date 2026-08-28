import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client.js';
import { answerQuestion, RefusalError } from '../../modules/commands.js';

export async function questionsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { status?: string } }>('/questions', async (req) => {
    const status = req.query.status === 'answered' ? 'answered' : 'open';
    const res = await query(
      `select q.id, q.pipeline_run_id, q.step_run_id, q.kind, q.body, q.choices,
              q.answer, q.status, q.created_at, q.answered_at,
              r.pipeline_name, r.issue_number
       from questions q join pipeline_runs r on r.id = q.pipeline_run_id
       where q.status = $1 order by q.created_at`,
      [status],
    );
    return res.rows;
  });

  app.post<{ Params: { id: string }; Body: { answer?: string } }>(
    '/questions/:id/answer',
    async (req, reply) => {
      try {
        await answerQuestion(req.params.id, req.body?.answer ?? '');
        return { answered: true };
      } catch (err) {
        if (err instanceof RefusalError) return reply.code(409).send(err.refusal);
        throw err;
      }
    },
  );
}
