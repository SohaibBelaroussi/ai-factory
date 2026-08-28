import type { FastifyInstance } from 'fastify';
import { query } from '../../db/client.js';

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { unread?: string; limit?: string } }>('/notifications', async (req) => {
    const unreadOnly = req.query.unread === 'true';
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const res = await query(
      `select id, event, pipeline_run_id, question_id, summary, read, created_at
       from notifications ${unreadOnly ? 'where not read' : ''}
       order by created_at desc limit $1`,
      [limit],
    );
    return res.rows;
  });

  app.post<{ Body: { ids?: string[]; all?: boolean } }>('/notifications/read', async (req, reply) => {
    if (req.body?.all === true) {
      const res = await query('update notifications set read = true where not read');
      return { marked: res.rowCount ?? 0 };
    }
    if (Array.isArray(req.body?.ids) && req.body.ids.length > 0) {
      const res = await query('update notifications set read = true where id = any($1)', [
        req.body.ids,
      ]);
      return { marked: res.rowCount ?? 0 };
    }
    return reply.code(422).send({ error: { code: 'validation', message: '{ids: [...]} or {all: true} required' } });
  });
}
