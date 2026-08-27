import type { FastifyInstance } from 'fastify';
import { getBoard, getIssueDetail } from '../../modules/projections.js';
import { syncIssuesIfStale } from '../../modules/issueSync.js';

export async function boardRoutes(app: FastifyInstance): Promise<void> {
  app.get('/board', async () => {
    try {
      await syncIssuesIfStale();
    } catch {
      // serve the cached projection; sync problems surface in /health
    }
    return getBoard();
  });

  app.get<{ Params: { n: string } }>('/issues/:n', async (req, reply) => {
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n <= 0) {
      return reply.code(422).send({ error: { code: 'validation', message: 'bad issue number' } });
    }
    try {
      await syncIssuesIfStale();
    } catch {
      // as above
    }
    const detail = await getIssueDetail(n);
    if (!detail) {
      return reply.code(404).send({ error: { code: 'not_found', message: `issue #${n} not found` } });
    }
    return detail;
  });
}
