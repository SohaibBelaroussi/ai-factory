import Fastify, { type FastifyInstance } from 'fastify';
import inngestFastify from 'inngest/fastify';
import { config } from '../config.js';
import { inngest } from '../inngest/client.js';
import { functions } from '../inngest/functions.js';
import { healthRoutes } from './routes/health.js';
import { settingsRoutes } from './routes/settings.js';
import { pipelinesRoutes } from './routes/pipelines.js';
import { runsRoutes } from './routes/runs.js';
import { internalRoutes } from './routes/internal.js';

/** Paths that never require the operator bearer token. */
const PUBLIC_PREFIXES = ['/health', '/api/inngest', '/hooks/', '/internal/'];

export function buildServer(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.addHook('onRequest', async (req, reply) => {
    if (!config.operatorToken) return;
    if (PUBLIC_PREFIXES.some((p) => req.url === p || req.url.startsWith(p))) return;
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${config.operatorToken}`) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'Missing or invalid bearer token' } });
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    app.log.error(err);
    const status = typeof err.statusCode === 'number' ? err.statusCode : 500;
    reply.code(status).send({ error: { code: 'internal', message: err.message } });
  });

  app.register(healthRoutes);
  app.register(settingsRoutes);
  app.register(pipelinesRoutes);
  app.register(runsRoutes);
  app.register(internalRoutes);

  // Inngest serve endpoint: the self-hosted Inngest server syncs and invokes
  // runner functions here. Auth is the Inngest signing key, not the bearer token.
  app.register(inngestFastify, {
    client: inngest,
    functions,
    options: {},
  });

  return app;
}
