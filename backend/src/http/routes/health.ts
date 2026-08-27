import type { FastifyInstance } from 'fastify';
import { checkHealth } from '../../modules/health.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => checkHealth());
}
